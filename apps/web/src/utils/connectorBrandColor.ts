// Brand colors for connector mention pills. Neither ConnectorDetail nor the
// upstream Composio catalog expose a brand color, so we keep a small curated
// map of common connectors and fall back to a deterministic hash → palette for
// everything else. Colors are kept dark enough to read on the light panel.

const CURATED: Record<string, string> = {
  notion: '#0B0B0B',
  chrome: '#1A73E8',
  claudeinchrome: '#1A73E8',
  googlesheets: '#188038',
  google_sheets: '#188038',
  spreadsheets: '#188038',
  github: '#1F2328',
  figma: '#A259FF',
  slack: '#4A154B',
  linear: '#5E6AD2',
  posthog: '#C8401A',
  gmail: '#C5221F',
  googledrive: '#1A73E8',
  airtable: '#D54402',
};

const FALLBACK_PALETTE = [
  '#1F6FEB',
  '#B5360F',
  '#2E7D32',
  '#6A4FB6',
  '#B0337A',
  '#0F766E',
  '#9A6A00',
  '#334155',
];

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

/** Stable FNV-style hash → palette index. */
function hashIndex(seed: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % modulo;
}

export function connectorBrandColor(connector: { id: string; name: string }): string {
  const idKey = normalizeKey(connector.id);
  if (CURATED[idKey]) return CURATED[idKey]!;
  const nameKey = normalizeKey(connector.name);
  if (CURATED[nameKey]) return CURATED[nameKey]!;
  const seed = connector.id || connector.name;
  return FALLBACK_PALETTE[hashIndex(seed, FALLBACK_PALETTE.length)]!;
}
