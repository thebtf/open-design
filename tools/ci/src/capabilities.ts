import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  atomCapabilities,
  type AtomCapability,
  type AtomDefinition,
  type AtomManifest,
  loadAtomManifest,
} from "./atoms.js";

export type CapabilityUnavailableReason = {
  capability: AtomCapability;
  reason: string;
};

export type ProviderCapabilityManifest = {
  capabilities: AtomCapability[];
  provider: string;
  schemaVersion: 1;
  unavailable?: CapabilityUnavailableReason[];
};

export type AtomUnavailableSelection = {
  atom: string;
  missingCapabilities: AtomCapability[];
  reason: string;
  status: "unavailable";
};

export type AtomSelection = {
  provider: string;
  schemaVersion: 1;
  selectedAtoms: string[];
  unavailable: AtomUnavailableSelection[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function assertCapability(value: unknown, path: string): AtomCapability {
  if (typeof value !== "string" || !atomCapabilities.includes(value as AtomCapability)) {
    throw new Error(`${path} must be one of: ${atomCapabilities.join(", ")}`);
  }
  return value as AtomCapability;
}

function parseCapabilities(value: unknown, path: string): AtomCapability[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return [...new Set(value.map((item, index) => assertCapability(item, `${path}.${index}`)))];
}

function parseUnavailableReason(value: unknown, path: string): CapabilityUnavailableReason {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    capability: assertCapability(value.capability, `${path}.capability`),
    reason: assertString(value.reason, `${path}.reason`),
  };
}

export function parseProviderCapabilities(value: unknown): ProviderCapabilityManifest {
  if (!isRecord(value)) {
    throw new Error("provider capabilities must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  const unavailable = value.unavailable == null
    ? undefined
    : (() => {
        if (!Array.isArray(value.unavailable)) {
          throw new Error("unavailable must be an array");
        }
        return value.unavailable.map((item, index) => parseUnavailableReason(item, `unavailable.${index}`));
      })();

  return {
    capabilities: parseCapabilities(value.capabilities, "capabilities"),
    provider: assertString(value.provider, "provider"),
    schemaVersion: 1,
    unavailable,
  };
}

export async function loadProviderCapabilities(capabilitiesPath: string): Promise<ProviderCapabilityManifest> {
  return parseProviderCapabilities(JSON.parse(await readFile(capabilitiesPath, "utf8")));
}

function reasonForMissingCapability(
  capability: AtomCapability,
  providerCapabilities: ProviderCapabilityManifest,
): string {
  return providerCapabilities.unavailable?.find((entry) => entry.capability === capability)?.reason
    ?? `missing-capability:${capability}`;
}

function unavailableSelectionForAtom(
  atom: AtomDefinition,
  providerCapabilities: ProviderCapabilityManifest,
): AtomUnavailableSelection | null {
  const available = new Set(providerCapabilities.capabilities);
  const missingCapabilities = atom.requires.filter((capability) => !available.has(capability));
  if (missingCapabilities.length === 0) {
    return null;
  }
  return {
    atom: atom.name,
    missingCapabilities,
    reason: missingCapabilities.map((capability) => reasonForMissingCapability(capability, providerCapabilities)).join(";"),
    status: "unavailable",
  };
}

export function selectAtoms(
  manifest: AtomManifest,
  providerCapabilities: ProviderCapabilityManifest,
): AtomSelection {
  const selectedAtoms: string[] = [];
  const unavailable: AtomUnavailableSelection[] = [];

  for (const atom of manifest.atoms) {
    const unavailableAtom = unavailableSelectionForAtom(atom, providerCapabilities);
    if (unavailableAtom == null) {
      selectedAtoms.push(atom.name);
    } else {
      unavailable.push(unavailableAtom);
    }
  }

  return {
    provider: providerCapabilities.provider,
    schemaVersion: 1,
    selectedAtoms,
    unavailable,
  };
}

export async function selectAtomsFromFiles(options: {
  capabilitiesPath: string;
  manifestPath: string;
  outPath?: string;
}): Promise<AtomSelection> {
  const manifest = await loadAtomManifest(resolve(options.manifestPath));
  const capabilities = await loadProviderCapabilities(resolve(options.capabilitiesPath));
  const selection = selectAtoms(manifest, capabilities);
  if (options.outPath != null) {
    await writeFile(resolve(options.outPath), `${JSON.stringify(selection, null, 2)}\n`, "utf8");
  }
  return selection;
}
