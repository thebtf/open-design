import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import {
  adaptAgentSkill,
  parseManifest,
  type RegistryView,
} from '@open-design/plugin-runtime';
import type {
  BundleChild,
  InstalledPluginRecord,
  PluginBundle,
  PluginManifest,
  PluginSourceKind,
} from '@open-design/contracts';
import type { ResolveOptions } from './registry.js';
import { resolvePluginFolder } from './registry.js';

export type BundleChildKind = 'skill' | 'design-system' | 'craft';

export interface BundleChildRecord {
  kind: BundleChildKind;
  declaration: BundleChild;
  id: string;
  fsPath: string;
  record: InstalledPluginRecord;
}

export interface BundleResolveOptions {
  bundleRoot: string;
  bundleRecord: InstalledPluginRecord;
  namespace: string;
  sourceKind: PluginSourceKind;
  source: string;
  resolveOptions: Omit<ResolveOptions, 'folder' | 'folderId' | 'sourceKind' | 'source'>;
}

export function bundleDeclarationFromManifest(manifest: PluginManifest): PluginBundle | null {
  return manifest.od?.kind === 'bundle' ? manifest.od.bundle ?? {} : null;
}

export function isBundleManifest(manifest: PluginManifest): boolean {
  return bundleDeclarationFromManifest(manifest) !== null;
}

export async function resolveBundleChildRecords(
  options: BundleResolveOptions,
): Promise<{ ok: true; records: BundleChildRecord[]; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] }> {
  const declaration = bundleDeclarationFromManifest(options.bundleRecord.manifest);
  if (!declaration) return { ok: true, records: [], warnings: [] };

  const warnings: string[] = [];
  const errors: string[] = [];
  const records: BundleChildRecord[] = [];
  const seenIds = new Set<string>();

  const groups: Array<{ kind: BundleChildKind; children: readonly BundleChild[] }> = [
    { kind: 'skill', children: declaration.skills ?? [] },
    { kind: 'design-system', children: declaration.designSystems ?? [] },
    { kind: 'craft', children: declaration.craft ?? [] },
  ];

  for (const group of groups) {
    for (const child of group.children) {
      const fullId = namespacedBundleChildId(options.namespace, child.id);
      if (seenIds.has(fullId)) {
        errors.push(`Bundle child id '${fullId}' is declared more than once`);
        continue;
      }
      seenIds.add(fullId);

      const resolvedPath = resolveBundleChildPath(options.bundleRoot, child.path);
      if (!resolvedPath.ok) {
        errors.push(`Bundle child '${child.id}' has unsafe path '${child.path}': ${resolvedPath.error}`);
        continue;
      }

      const built = group.kind === 'skill'
        ? await resolveSkillChild(options, child, fullId, resolvedPath.path)
        : await synthesizeResourceChild(options, group.kind, child, fullId, resolvedPath.path);
      if (!built.ok) {
        errors.push(...built.errors);
        warnings.push(...built.warnings);
        continue;
      }
      warnings.push(...built.warnings);
      records.push({
        kind: group.kind,
        declaration: child,
        id: fullId,
        fsPath: resolvedPath.path,
        record: built.record,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, records, warnings };
}

export function buildBundleRegistryOverlay(
  manifest: PluginManifest,
  fallback: RegistryView,
  bundleRoot?: string,
  namespace = manifest.name,
): RegistryView {
  const declaration = bundleDeclarationFromManifest(manifest);
  if (!declaration || !bundleRoot) return fallback;

  const skills: Array<{ id: string; title?: string; description?: string }> = [];
  const designSystems: Array<{ id: string; title?: string }> = [];
  const craft: Array<{ id: string; title?: string }> = [];

  for (const child of declaration.skills ?? []) {
    const resolved = resolveBundleChildPath(bundleRoot, child.path);
    if (!resolved.ok) continue;
    const metadata = readSkillMetadata(resolved.path, child.id);
    const entry: { title?: string; description?: string } = {};
    if (metadata.title) entry.title = metadata.title;
    if (metadata.description) entry.description = metadata.description;
    addRegistryAliases(skills, child.id, namespacedBundleChildId(namespace, child.id), entry);
  }

  for (const child of declaration.designSystems ?? []) {
    const resolved = resolveBundleChildPath(bundleRoot, child.path);
    if (!resolved.ok) continue;
    const title = readDesignSystemTitle(resolved.path, child.id);
    addRegistryAliases(designSystems, child.id, namespacedBundleChildId(namespace, child.id), { title });
  }

  for (const child of declaration.craft ?? []) {
    const resolved = resolveBundleChildPath(bundleRoot, child.path);
    if (!resolved.ok) continue;
    const title = readMarkdownTitle(resolved.path, child.id);
    addRegistryAliases(craft, child.id, namespacedBundleChildId(namespace, child.id), { title });
  }

  return {
    ...fallback,
    skills: [...skills, ...fallback.skills],
    designSystems: [...designSystems, ...fallback.designSystems],
    craft: [...craft, ...fallback.craft],
  };
}

export function buildBundleRegistryOverlayForPlugin(
  plugin: InstalledPluginRecord,
  fallback: RegistryView,
): RegistryView {
  const namespace = bundleNamespaceForRecord(plugin);
  const direct = buildBundleRegistryOverlay(plugin.manifest, fallback, plugin.fsPath, namespace);
  if (direct !== fallback || isBundleManifest(plugin.manifest)) return direct;

  const ancestor = findAncestorBundleManifest(plugin.fsPath);
  if (!ancestor) return fallback;
  return buildBundleRegistryOverlay(ancestor.manifest, fallback, ancestor.root, namespace);
}

export function namespacedBundleChildId(namespace: string, childId: string): string {
  return `${namespace}/${childId}`;
}

export function bundleNamespaceForRecord(record: InstalledPluginRecord): string {
  if (record.sourceMarketplaceEntryName) return record.sourceMarketplaceEntryName;
  const slash = record.id.lastIndexOf('/');
  return slash > 0 ? record.id.slice(0, slash) : record.id;
}

function findAncestorBundleManifest(startPath: string): { root: string; manifest: PluginManifest } | null {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);
  for (let i = 0; i < 8; i += 1) {
    const manifestPath = path.join(current, 'open-design.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
        if (parsed.ok && isBundleManifest(parsed.manifest)) {
          return { root: current, manifest: parsed.manifest };
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveBundleChildPath(root: string, declaredPath: string): { ok: true; path: string } | { ok: false; error: string } {
  if (declaredPath.includes('\0')) return { ok: false, error: 'path contains NUL' };
  if (path.isAbsolute(declaredPath)) return { ok: false, error: 'absolute paths are not allowed' };
  const rootAbs = path.resolve(root);
  const childAbs = path.resolve(rootAbs, declaredPath);
  const rel = path.relative(rootAbs, childAbs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'path escapes the bundle root' };
  }
  return { ok: true, path: childAbs };
}

async function resolveSkillChild(
  options: BundleResolveOptions,
  child: BundleChild,
  fullId: string,
  fsPath: string,
): Promise<{ ok: true; record: InstalledPluginRecord; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] }> {
  const resolved = await resolvePluginFolder({
    ...options.resolveOptions,
    folder: fsPath,
    folderId: child.id,
    sourceKind: options.sourceKind,
    source: options.source,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      errors: resolved.errors.map((error) => `Bundle skill '${child.id}': ${error}`),
      warnings: resolved.warnings,
    };
  }
  if (resolved.record.id !== child.id) {
    return {
      ok: false,
      errors: [`Bundle skill '${child.id}' resolved manifest id '${resolved.record.id}', expected '${child.id}'`],
      warnings: resolved.warnings,
    };
  }
  return {
    ok: true,
    warnings: resolved.warnings,
    record: {
      ...resolved.record,
      id: fullId,
      source: options.source,
      fsPath,
    },
  };
}

async function synthesizeResourceChild(
  options: BundleResolveOptions,
  kind: Exclude<BundleChildKind, 'skill'>,
  child: BundleChild,
  fullId: string,
  fsPath: string,
): Promise<{ ok: true; record: InstalledPluginRecord; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] }> {
  const requiredFile = kind === 'design-system' ? path.join(fsPath, 'DESIGN.md') : fsPath;
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(requiredFile);
  } catch (err) {
    return {
      ok: false,
      errors: [`Bundle ${kind} '${child.id}' not found at ${child.path}: ${(err as Error).message}`],
      warnings: [],
    };
  }
  if (kind === 'design-system' && !stat.isFile()) {
    return { ok: false, errors: [`Bundle design-system '${child.id}' must contain DESIGN.md`], warnings: [] };
  }
  if (kind === 'craft' && !stat.isFile()) {
    return { ok: false, errors: [`Bundle craft '${child.id}' path must point to a markdown file`], warnings: [] };
  }

  const now = Date.now();
  const title = kind === 'design-system'
    ? readDesignSystemTitle(fsPath, child.id)
    : readMarkdownTitle(fsPath, child.id);
  const manifest: PluginManifest = {
    name: child.id,
    version: options.bundleRecord.version,
    title,
    od: {},
  };
  const record: InstalledPluginRecord = {
    id: fullId,
    title,
    version: options.bundleRecord.version,
    sourceKind: options.sourceKind,
    source: options.source,
    pinnedRef: options.resolveOptions.pinnedRef,
    sourceMarketplaceId: options.resolveOptions.sourceMarketplaceId,
    sourceMarketplaceEntryName: options.resolveOptions.sourceMarketplaceEntryName,
    sourceMarketplaceEntryVersion: options.resolveOptions.sourceMarketplaceEntryVersion,
    marketplaceTrust: options.resolveOptions.marketplaceTrust,
    resolvedSource: options.resolveOptions.resolvedSource,
    resolvedRef: options.resolveOptions.resolvedRef,
    manifestDigest: options.resolveOptions.manifestDigest,
    archiveIntegrity: options.resolveOptions.archiveIntegrity,
    trust: options.resolveOptions.trust ?? 'restricted',
    capabilitiesGranted: options.bundleRecord.capabilitiesGranted,
    manifest,
    fsPath,
    installedAt: now,
    updatedAt: now,
  };
  return { ok: true, record, warnings: [] };
}

function readSkillMetadata(folder: string, fallbackId: string): { title?: string; description?: string } {
  try {
    const raw = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    const adapted = adaptAgentSkill(raw, { folderId: fallbackId });
    return {
      title: adapted.manifest.title ?? adapted.manifest.name ?? fallbackId,
      description: adapted.manifest.description,
    };
  } catch {
    return { title: fallbackId };
  }
}

function readDesignSystemTitle(folder: string, fallbackId: string): string {
  return readMarkdownTitle(path.join(folder, 'DESIGN.md'), fallbackId);
}

function readMarkdownTitle(filePath: string, fallbackId: string): string {
  try {
    const body = fs.readFileSync(filePath, 'utf8');
    const heading = /^#\s+(.+)$/m.exec(body);
    return heading?.[1]?.trim() || fallbackId;
  } catch {
    return fallbackId;
  }
}

function addRegistryAliases<T extends { id: string }>(
  entries: T[],
  shortId: string,
  fullId: string,
  rest: Omit<T, 'id'>,
): void {
  entries.push({ id: shortId, ...rest } as T);
  entries.push({ id: fullId, ...rest } as T);
}
