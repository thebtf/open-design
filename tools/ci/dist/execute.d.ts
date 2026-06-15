import { type AtomManifest } from "./atoms.js";
import { type AtomSelection } from "./capabilities.js";
import { type NormalizedEnvelope } from "./envelope.js";
export type AtomExecutionStatus = "success" | "failure" | "not-run";
export type AtomExecutionResult = {
    action: string;
    artifactDir?: string;
    domain?: string;
    exitCode?: number;
    kind: "real" | "placeholder";
    key?: string;
    metadataPath?: string;
    missingCapabilities?: string[];
    reason?: string;
    status: AtomExecutionStatus;
    steps?: unknown[];
    stderr?: string;
    stdout?: string;
};
export type CiExecutionResult = {
    actions: AtomExecutionResult[];
    eventName: string;
    headSha: string;
    mode: string;
    provider: string;
    runAttempt: string;
    runId: string;
    schemaVersion: 1;
};
export type ExecuteAtomsOptions = {
    envelope?: NormalizedEnvelope;
    manifest: AtomManifest;
    selection: AtomSelection;
};
export declare function executeAtoms(options: ExecuteAtomsOptions): Promise<CiExecutionResult>;
export declare function executeAtomsFromFiles(options: {
    manifestPath: string;
    selectionPath: string;
}): Promise<CiExecutionResult>;
//# sourceMappingURL=execute.d.ts.map