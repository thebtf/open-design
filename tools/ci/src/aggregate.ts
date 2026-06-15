import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type WorkflowActionKind = "real" | "placeholder";
export type WorkflowActionStatus = "success" | "failure" | "not-run";

export type WorkflowActionResult = {
  action: string;
  kind: WorkflowActionKind;
  status: WorkflowActionStatus;
  steps?: unknown[];
};

export type WorkflowResult = {
  actions: WorkflowActionResult[];
  eventName: string;
  headSha: string;
  mode: string;
  provider: string;
  runAttempt: string;
  runId: string;
  schemaVersion: 1;
};

export type AggregatedActionResult = {
  action: string;
  passed: boolean;
  reason: string;
};

export type AggregateResult = {
  actions: AggregatedActionResult[];
  passed: boolean;
  runner: {
    provider: string;
    runId: string;
  };
  hosted: {
    provider: string;
    runId: string;
  };
  schemaVersion: 1;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflowAction(value: unknown): WorkflowActionResult {
  if (!isRecord(value)) {
    throw new Error("workflow action must be an object");
  }
  const action = String(value.action ?? "");
  const kind = String(value.kind ?? "");
  const status = String(value.status ?? "");
  if (action.length === 0) {
    throw new Error("workflow action name is required");
  }
  if (kind !== "real" && kind !== "placeholder") {
    throw new Error(`unsupported workflow action kind: ${kind}`);
  }
  if (status !== "success" && status !== "failure" && status !== "not-run") {
    throw new Error(`unsupported workflow action status: ${status}`);
  }
  return {
    action,
    kind,
    status,
    steps: Array.isArray(value.steps) ? value.steps : undefined,
  };
}

export function parseWorkflowResult(value: unknown): WorkflowResult {
  if (!isRecord(value)) {
    throw new Error("workflow result must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`unsupported workflow result schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (!Array.isArray(value.actions)) {
    throw new Error("workflow result actions must be an array");
  }
  return {
    actions: value.actions.map(parseWorkflowAction),
    eventName: String(value.eventName ?? ""),
    headSha: String(value.headSha ?? ""),
    mode: String(value.mode ?? ""),
    provider: String(value.provider ?? ""),
    runAttempt: String(value.runAttempt ?? ""),
    runId: String(value.runId ?? ""),
    schemaVersion: 1,
  };
}

function resultByAction(result: WorkflowResult): Map<string, WorkflowActionResult> {
  const map = new Map<string, WorkflowActionResult>();
  for (const action of result.actions) {
    if (map.has(action.action)) {
      throw new Error(`${result.provider} result has duplicate action: ${action.action}`);
    }
    map.set(action.action, action);
  }
  return map;
}

function summarizeAction(action: string, runner: WorkflowResult, hosted: WorkflowResult): AggregatedActionResult {
  const candidates = [runner, hosted]
    .flatMap((result) => result.actions
      .filter((entry) => entry.action === action)
      .map((entry) => ({ ...entry, provider: result.provider })));
  const realCandidates = candidates.filter((entry) => entry.kind === "real");
  const successes = realCandidates.filter((entry) => entry.status === "success");
  if (successes.length > 0) {
    return {
      action,
      passed: true,
      reason: `success via ${successes.map((entry) => entry.provider).join(", ")}`,
    };
  }
  if (realCandidates.length > 0) {
    return {
      action,
      passed: false,
      reason: `real results but no success (${realCandidates.map((entry) => `${entry.provider}:${entry.status}`).join(", ")})`,
    };
  }
  return {
    action,
    passed: false,
    reason: "no real result available",
  };
}

export function aggregateWorkflowResults(runner: WorkflowResult, hosted: WorkflowResult): AggregateResult {
  const runnerActions = resultByAction(runner);
  const hostedActions = resultByAction(hosted);
  const actions = [...new Set([...runnerActions.keys(), ...hostedActions.keys()])].sort();
  const actionResults = actions.map((action) => summarizeAction(action, runner, hosted));
  return {
    actions: actionResults,
    hosted: {
      provider: hosted.provider,
      runId: hosted.runId,
    },
    passed: actionResults.every((action) => action.passed),
    runner: {
      provider: runner.provider,
      runId: runner.runId,
    },
    schemaVersion: 1,
  };
}

export async function aggregateWorkflowResultFiles(options: {
  hostedResultsPath: string;
  outPath?: string;
  runnerResultsPath: string;
}): Promise<AggregateResult> {
  const runner = parseWorkflowResult(JSON.parse(await readFile(resolve(options.runnerResultsPath), "utf8")));
  const hosted = parseWorkflowResult(JSON.parse(await readFile(resolve(options.hostedResultsPath), "utf8")));
  const result = aggregateWorkflowResults(runner, hosted);
  if (options.outPath != null) {
    await writeFile(resolve(options.outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}
