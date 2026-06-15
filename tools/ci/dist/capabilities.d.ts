import { type AtomCapability, type AtomManifest } from "./atoms.js";
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
export declare function parseProviderCapabilities(value: unknown): ProviderCapabilityManifest;
export declare function loadProviderCapabilities(capabilitiesPath: string): Promise<ProviderCapabilityManifest>;
export declare function selectAtoms(manifest: AtomManifest, providerCapabilities: ProviderCapabilityManifest): AtomSelection;
export declare function selectAtomsFromFiles(options: {
    capabilitiesPath: string;
    manifestPath: string;
    outPath?: string;
}): Promise<AtomSelection>;
//# sourceMappingURL=capabilities.d.ts.map