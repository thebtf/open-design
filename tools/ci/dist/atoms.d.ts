export declare const atomDomains: readonly ["workspace", "packages", "apps", "e2e", "nix"];
export declare const atomCapabilities: readonly ["node", "pnpm", "nix", "playwright", "chromium"];
export declare const atomSetupProfiles: readonly ["none", "pnpm-workspace", "nix-flake", "browser-e2e"];
export declare const atomCacheProfiles: readonly ["none", "node-pnpm", "nix", "browser"];
export declare const atomArtifactProfiles: readonly ["standard", "browser", "nix"];
export type AtomDomain = (typeof atomDomains)[number];
export type AtomCapability = (typeof atomCapabilities)[number];
export type AtomSetupProfile = (typeof atomSetupProfiles)[number];
export type AtomCacheProfile = (typeof atomCacheProfiles)[number];
export type AtomArtifactProfile = (typeof atomArtifactProfiles)[number];
export type AtomDefinition = {
    artifactProfile: AtomArtifactProfile;
    cacheProfile: AtomCacheProfile;
    call: string;
    domain: AtomDomain;
    key: string;
    name: string;
    requires: AtomCapability[];
    resultRequired: boolean;
    script: string;
    setup: AtomSetupProfile;
    timeoutSeconds: number;
};
export type AtomManifest = {
    atoms: AtomDefinition[];
    schemaVersion: 1;
};
export type AtomManifestValidationOptions = {
    manifestPath?: string;
    requireScriptFiles?: boolean;
    repoRoot?: string;
};
export type AtomManifestValidationResult = {
    atomCount: number;
    atomNames: string[];
    manifest: AtomManifest;
};
export declare function atomNameFromIdentity(domain: AtomDomain, key: string): string;
export declare function deriveAtomIdentity(name: string): {
    domain: AtomDomain;
    key: string;
    call: string;
};
export declare function parseAtomManifest(value: unknown): AtomManifest;
export declare function loadAtomManifest(manifestPath: string): Promise<AtomManifest>;
export declare function validateAtomManifest(manifestPath: string, options?: AtomManifestValidationOptions): Promise<AtomManifestValidationResult>;
//# sourceMappingURL=atoms.d.ts.map