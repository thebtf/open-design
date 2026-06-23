import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowserWindow } from "electron";
import type {
  DesktopExportArtifactInput,
  DesktopExportArtifactResult,
} from "@open-design/sidecar-proto";

import { DECK_PAGE_SIZE, DECK_PRINT_CSS, inferPageSize, waitForPrintableContent } from "./pdf-export.js";

// Headless programmatic exporter for the `od export` CLI (PDF / PPTX / image).
// The on-screen web Download menu rasterizes client-side; this is the daemon →
// Electron path so the CLI gets the desktop's bundled Chromium for pixel-perfect
// output without a print dialog. Renders into an off-screen BrowserWindow, writes
// the result to a temp file, and returns its path; the daemon streams those bytes
// to the HTTP caller and removes the temp file.

const PPTX_LAYOUT_WIDTH_IN = 13.333;

type Shape =
  | { type: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { type: "image"; x: number; y: number; w: number; h: number; dataUrl?: string | null; src?: string }
  | {
      type: "text";
      x: number; y: number; w: number; h: number;
      text: string; fontSize: number; fontFamily: string;
      bold: boolean; italic: boolean; color: string;
      align: "left" | "center" | "right" | "justify";
    };

type CapturedSlide = { dataUrl?: string; shapes?: Shape[]; w: number; h: number; notes?: string };

export async function exportArtifact(
  input: DesktopExportArtifactInput,
): Promise<DesktopExportArtifactResult> {
  const width = input.width ?? (input.deck ? 1920 : 1440);
  const height = input.height ?? (input.deck ? 1080 : 900);

  const window = new BrowserWindow({
    height,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    width,
  });

  try {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildDocument(input))}`);
    await waitForPrintableContent(window);

    if (input.format === "pdf") return await renderPdf(window, input);
    if (input.format === "image") return await renderImage(window, input);
    return await renderPptx(window, input, width, height);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function renderPdf(
  window: BrowserWindow,
  input: DesktopExportArtifactInput,
): Promise<DesktopExportArtifactResult> {
  const pageSize = input.deck ? DECK_PAGE_SIZE : await inferPageSize(window);
  const pdf = await window.webContents.printToPDF({
    margins: { bottom: 0, left: 0, right: 0, top: 0 },
    pageSize,
    preferCSSPageSize: true,
    printBackground: true,
  });
  const filePath = await writeTemp("pdf", Buffer.from(pdf));
  return { bytes: pdf.length, mime: "application/pdf", ok: true, path: filePath };
}

async function renderImage(
  window: BrowserWindow,
  input: DesktopExportArtifactInput,
): Promise<DesktopExportArtifactResult> {
  // For a non-deck page, grow the window to the content height so capturePage
  // grabs the full scrollable page rather than just the first viewport.
  if (!input.deck) {
    const contentHeight = (await window.webContents.executeJavaScript(
      `Math.min(20000, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))`,
      true,
    )) as number;
    if (Number.isFinite(contentHeight) && contentHeight > 0) {
      const [w] = window.getContentSize();
      window.setContentSize(w, Math.ceil(contentHeight));
      await waitForPrintableContent(window);
    }
  }
  const image = await window.webContents.capturePage();
  // Only PNG and JPEG reach this point: the export contract and the sidecar
  // proto validator both reject any other image format (notably WebP) up front,
  // because Electron's nativeImage encoder supports only these two. Never
  // silently downgrade an unsupported format to PNG here.
  if (input.imageFormat === "jpeg") {
    const buf = image.toJPEG(92);
    return { bytes: buf.length, mime: "image/jpeg", ok: true, path: await writeTemp("jpg", buf) };
  }
  const buf = image.toPNG();
  return { bytes: buf.length, mime: "image/png", ok: true, path: await writeTemp("png", buf) };
}

async function renderPptx(
  window: BrowserWindow,
  input: DesktopExportArtifactInput,
  width: number,
  height: number,
): Promise<DesktopExportArtifactResult> {
  const editable = input.format === "pptx-editable";
  await window.webContents.executeJavaScript(NAVIGATOR_SCRIPT, true);
  const count = input.deck
    ? Math.max(1, Number(await window.webContents.executeJavaScript(`window.__odExpCount()`, true)) || 1)
    : 1;

  const slides: CapturedSlide[] = [];
  for (let i = 0; i < count; i++) {
    if (input.deck && count > 1) {
      await window.webContents.executeJavaScript(`window.__odExpGoto(${i})`, true);
      await waitForPrintableContent(window);
    }
    const notes = String(await window.webContents.executeJavaScript(`window.__odExpNotes(${i})`, true) || "");
    if (editable) {
      const captured = (await window.webContents.executeJavaScript(
        `window.__odExpExtract(${input.deck ? "true" : "false"})`,
        true,
      )) as { shapes: Shape[]; w: number; h: number };
      slides.push({ h: captured.h, notes, shapes: captured.shapes, w: captured.w });
    } else {
      const image = await window.webContents.capturePage();
      const size = image.getSize();
      slides.push({ dataUrl: image.toDataURL(), h: size.height || height, notes, w: size.width || width });
    }
  }

  const buf = editable ? await buildEditablePptx(slides) : await buildImagePptx(slides);
  return { bytes: buf.length, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ok: true, path: await writeTemp("pptx", buf) };
}

async function buildImagePptx(slides: CapturedSlide[]): Promise<Buffer> {
  // pptxgenjs ships an ESM `export default <class>`; NodeNext interop types its
  // default as the namespace, so construct through an untyped binding (the ESM
  // runtime default is the class, as the web export path relies on too).
  const mod: any = await import("pptxgenjs");
  const PptxGenJS = mod.default ?? mod;
  const pptx = new PptxGenJS();
  const first = slides[0];
  const aspect = first && first.w > 0 ? first.h / first.w : 9 / 16;
  const layoutH = Number((PPTX_LAYOUT_WIDTH_IN * aspect).toFixed(3));
  pptx.defineLayout({ name: "OD", width: PPTX_LAYOUT_WIDTH_IN, height: layoutH });
  pptx.layout = "OD";
  for (const s of slides) {
    const slide = pptx.addSlide();
    if (s.dataUrl) slide.addImage({ data: s.dataUrl, h: layoutH, w: PPTX_LAYOUT_WIDTH_IN, x: 0, y: 0 });
    if (s.notes) slide.addNotes(s.notes);
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

async function buildEditablePptx(slides: CapturedSlide[]): Promise<Buffer> {
  const mod: any = await import("pptxgenjs");
  const PptxGenJS = mod.default ?? mod;
  const pptx = new PptxGenJS();
  const first = slides[0];
  const baseW = first && first.w > 0 ? first.w : 1920;
  const layoutH = Number((PPTX_LAYOUT_WIDTH_IN * ((first ? first.h : 1080) / baseW)).toFixed(3));
  pptx.defineLayout({ name: "OD", width: PPTX_LAYOUT_WIDTH_IN, height: layoutH });
  pptx.layout = "OD";
  for (const s of slides) {
    const slide = pptx.addSlide();
    const pxToIn = PPTX_LAYOUT_WIDTH_IN / (s.w > 0 ? s.w : baseW);
    const inch = (v: number) => Number((v * pxToIn).toFixed(3));
    for (const shape of s.shapes ?? []) {
      const x = inch(shape.x);
      const y = inch(shape.y);
      const w = Math.max(0.05, inch(shape.w));
      const h = Math.max(0.05, inch(shape.h));
      try {
        if (shape.type === "rect") {
          slide.addShape(pptx.ShapeType.rect, { fill: { color: shape.fill }, h, w, x, y });
        } else if (shape.type === "image") {
          if (shape.dataUrl) slide.addImage({ data: shape.dataUrl, h, w, x, y });
          else if (shape.src) slide.addImage({ h, path: shape.src, w, x, y });
        } else {
          slide.addText(shape.text, {
            align: shape.align,
            bold: shape.bold,
            color: shape.color,
            fit: "shrink",
            fontSize: Math.max(1, Number((shape.fontSize * pxToIn * 72).toFixed(1))),
            h,
            italic: shape.italic,
            margin: 0,
            valign: "top",
            w,
            x,
            y,
            ...(shape.fontFamily ? { fontFace: shape.fontFamily } : {}),
          });
        }
      } catch {
        /* skip shapes pptxgenjs rejects */
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

function buildDocument(input: DesktopExportArtifactInput): string {
  let doc = injectBaseHref(input.html, input.baseHref);
  doc = injectTitle(doc, input.title);
  if (input.deck && input.format === "pdf") doc = injectStyle(doc, DECK_PRINT_CSS);
  return doc;
}

function injectBaseHref(doc: string, baseHref: string | undefined): string {
  if (!baseHref) return doc;
  const tag = `<base href="${escapeAttr(baseHref)}">`;
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `<!doctype html><html><head>${tag}</head><body>${doc}</body></html>`;
}

function injectTitle(doc: string, title: string): string {
  const tag = `<title>${escapeText(title)}</title>`;
  if (/<title[^>]*>.*?<\/title>/is.test(doc)) return doc.replace(/<title[^>]*>.*?<\/title>/is, tag);
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  return doc;
}

function injectStyle(doc: string, css: string): string {
  const tag = `<style data-od-artifact-export>${css}</style>`;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${tag}</head>`);
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  return `${tag}${doc}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function writeTemp(extension: string, data: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "od-export-"));
  const filePath = path.join(dir, `artifact.${extension}`);
  await writeFile(filePath, data);
  return filePath;
}

// In-page helpers injected before pptx capture. Mirrors the generic slide
// navigation + shape extraction of the web export-capture bridge
// (apps/web/src/runtime/srcdoc.ts), adapted to run in the Electron renderer.
const NAVIGATOR_SCRIPT = `(function(){
  function odSlides(){
    var s = document.querySelectorAll('.deck > .slide, .deck-stage > .slide, .deck-shell > .slide, body > .slide');
    if (!s.length) s = document.querySelectorAll('.slide');
    return s;
  }
  window.__odExpCount = function(){ return odSlides().length || 1; };
  window.__odExpGoto = function(i){
    var list = odSlides(); if (!list.length) return;
    i = Math.max(0, Math.min(list.length-1, i));
    var hasActive = false;
    for (var k=0;k<list.length;k++){ var c = list[k].classList; if (c && (c.contains('active')||c.contains('is-active')||c.contains('current'))){ hasActive=true; break; } }
    if (hasActive){
      for (var k=0;k<list.length;k++){ var on = (k===i); list[k].classList.toggle('active', on); list[k].classList.toggle('is-active', on); list[k].classList.toggle('current', on); }
      return;
    }
    var sc = document.scrollingElement || document.documentElement;
    if (sc && sc.scrollWidth > sc.clientWidth + 1){ sc.scrollLeft = i * window.innerWidth; return; }
    try { list[i].scrollIntoView({ block:'start', inline:'start' }); } catch(_){}
  };
  window.__odExpNotes = function(i){
    var el = document.getElementById('speaker-notes'); if (!el) return '';
    var t = el.textContent || '';
    try { var j = JSON.parse(t); if (Array.isArray(j)) return j[i] || ''; } catch(_){}
    return i === 0 ? t.replace(/\\s+/g,' ').trim() : '';
  };
  function num(v){ var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function parseRgb(c){
    if (!c) return null; c = String(c).trim();
    if (c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
    var m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    if (p.length >= 4 && p[3] === 0) return null;
    return { r: p[0]||0, g: p[1]||0, b: p[2]||0 };
  }
  function toHex(c){
    var rgb = parseRgb(c); if (!rgb) return null;
    function h(x){ x = Math.max(0, Math.min(255, Math.round(x))).toString(16); return x.length<2?'0'+x:x; }
    return (h(rgb.r) + h(rgb.g) + h(rgb.b)).toUpperCase();
  }
  function imgToDataUrl(img){
    try { var c = document.createElement('canvas'); c.width = img.naturalWidth||img.width; c.height = img.naturalHeight||img.height; if (!c.width||!c.height) return null; c.getContext('2d').drawImage(img,0,0); return c.toDataURL('image/png'); } catch(_){ return null; }
  }
  function hasDirectText(el){ for (var n=el.firstChild;n;n=n.nextSibling){ if (n.nodeType===3 && (n.nodeValue||'').replace(/\\s+/g,' ').trim()) return true; } return false; }
  window.__odExpExtract = function(deck){
    var list = odSlides();
    var st = { active: 0 };
    for (var k=0;k<list.length;k++){ var c=list[k].classList; if (c && (c.contains('active')||c.contains('is-active')||c.contains('current'))){ st.active=k; break; } }
    var root = (deck && list.length) ? (list[st.active] || document.body) : document.body;
    var base = root.getBoundingClientRect();
    var shapes = []; var MAX = 600;
    var rootBg = toHex(getComputedStyle(root).backgroundColor);
    if (rootBg) shapes.push({ type:'rect', x:0, y:0, w: base.width, h: base.height, fill: rootBg });
    var all = root.querySelectorAll('*');
    for (var i=0;i<all.length && shapes.length<MAX;i++){
      var el = all[i]; var cs = getComputedStyle(el);
      if (cs.display==='none'||cs.visibility==='hidden'||num(cs.opacity)===0) continue;
      var r = el.getBoundingClientRect(); if (r.width<2||r.height<2) continue;
      var x = r.left-base.left, y = r.top-base.top; var tag = el.tagName.toLowerCase();
      if (tag==='img'){ shapes.push({ type:'image', x:x, y:y, w:r.width, h:r.height, dataUrl: imgToDataUrl(el), src: el.currentSrc||el.src||'' }); continue; }
      if (tag==='script'||tag==='style'||tag==='noscript') continue;
      var fill = toHex(cs.backgroundColor);
      if (fill) shapes.push({ type:'rect', x:x, y:y, w:r.width, h:r.height, fill: fill });
      if (hasDirectText(el)){
        var text = (el.textContent||'').replace(/\\s+/g,' ').trim();
        if (text){ var fw = cs.fontWeight; shapes.push({ type:'text', x:x, y:y, w:r.width, h:r.height, text:text, fontSize:num(cs.fontSize), fontFamily:(cs.fontFamily||'').split(',')[0].replace(/["']/g,'').trim(), bold:(fw==='bold'||fw==='bolder'||parseInt(fw,10)>=600), italic:(cs.fontStyle==='italic'), color: toHex(cs.color)||'000000', align: (cs.textAlign==='center'||cs.textAlign==='right'||cs.textAlign==='justify')?cs.textAlign:'left' }); }
      }
    }
    return { shapes: shapes, w: base.width, h: base.height };
  };
})();`;
