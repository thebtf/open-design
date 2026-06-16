import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  aggregateWorkflowResults,
  parseWorkflowResult,
  validateWorkflowResultAgainstManifest,
  type WorkflowResult,
} from "./aggregate.js";
import { loadAtomManifest } from "./atoms.js";

const execFileAsync = promisify(execFile);

type Provider = "owned" | "github";

type WorkflowRun = {
  conclusion: string | null;
  created_at: string;
  event: string;
  head_sha: string;
  html_url: string;
  id: number;
  name: string;
  status: string;
};

export type GateCiOptions = {
  githubRunId?: string;
  githubWorkflow?: string;
  manifestPath: string;
  ownedRunId?: string;
  ownedWorkflow?: string;
  pollIntervalSeconds?: number;
  providerRunCreatedAfter?: string;
  repository: string;
  summaryPath?: string;
  targetEvent?: string;
  targetSha?: string;
  timeoutSeconds?: number;
  token: string;
};

export type GateCiResult = {
  githubRun: WorkflowRun;
  githubResult: WorkflowResult;
  ownedRun: WorkflowRun;
  ownedResult: WorkflowResult;
  passed: boolean;
  summaryLines: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sortNewest(runs: WorkflowRun[]): WorkflowRun[] {
  return [...runs].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

function requireValue(value: string | undefined, name: string): string {
  if (value == null || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function gateOptionsWithDefaults(options: GateCiOptions): Required<GateCiOptions> {
  return {
    githubRunId: options.githubRunId ?? process.env.GITHUB_RUN_ID_OVERRIDE ?? "",
    githubWorkflow: options.githubWorkflow ?? process.env.GITHUB_CI_WORKFLOW ?? "ci-github",
    manifestPath: options.manifestPath,
    ownedRunId: options.ownedRunId ?? process.env.OWNED_RUN_ID ?? "",
    ownedWorkflow: options.ownedWorkflow ?? process.env.OWNED_WORKFLOW ?? "ci-owned",
    pollIntervalSeconds: options.pollIntervalSeconds ?? Number(process.env.POLL_INTERVAL_SECONDS ?? "20"),
    providerRunCreatedAfter: options.providerRunCreatedAfter ?? process.env.PROVIDER_RUN_CREATED_AFTER ?? "",
    repository: options.repository,
    summaryPath: options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY ?? "",
    targetEvent: options.targetEvent ?? process.env.TARGET_EVENT ?? "",
    targetSha: options.targetSha ?? process.env.TARGET_SHA ?? "",
    timeoutSeconds: options.timeoutSeconds ?? Number(process.env.POLL_TIMEOUT_SECONDS ?? "3600"),
    token: options.token,
  };
}

async function github<T>(options: Required<GateCiOptions>, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "User-Agent": "open-design-tools-ci",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

async function fetchRunById(options: Required<GateCiOptions>, id: string): Promise<WorkflowRun> {
  return await github<WorkflowRun>(options, `/repos/${options.repository}/actions/runs/${id}`);
}

async function findRunByWorkflowName(
  options: Required<GateCiOptions>,
  workflowName: string,
  targetSha: string,
  targetEvent: string,
): Promise<WorkflowRun | null> {
  const payload = await github<{ workflow_runs: WorkflowRun[] }>(
    options,
    `/repos/${options.repository}/actions/runs?head_sha=${encodeURIComponent(targetSha)}&event=${encodeURIComponent(targetEvent)}&per_page=100`,
  );
  const createdAfterMs = options.providerRunCreatedAfter.length > 0
    ? Date.parse(options.providerRunCreatedAfter)
    : Number.NaN;
  const matches = sortNewest(payload.workflow_runs).filter((run) => {
    if (run.name !== workflowName) return false;
    if (Number.isNaN(createdAfterMs)) return true;
    return Date.parse(run.created_at) >= createdAfterMs;
  });
  return matches[0] ?? null;
}

async function waitForRun(
  options: Required<GateCiOptions>,
  workflowName: string,
  explicitRunId: string,
  targetSha: string,
  targetEvent: string,
): Promise<WorkflowRun> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  while (true) {
    const run = explicitRunId.length > 0
      ? await fetchRunById(options, explicitRunId)
      : await findRunByWorkflowName(options, workflowName, targetSha, targetEvent);
    if (run != null) {
      if (run.head_sha !== targetSha) {
        throw new Error(`${workflowName} run ${run.id} head_sha ${run.head_sha} does not match target ${targetSha}`);
      }
      if (run.status === "completed") {
        return run;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${workflowName} to complete for ${targetSha}`);
    }
    await sleep(options.pollIntervalSeconds * 1000);
  }
}

async function findResultFile(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === "ci-results.json") {
      return path;
    }
    if (entry.isDirectory()) {
      try {
        return await findResultFile(path);
      } catch {
        // Continue walking sibling directories.
      }
    }
  }
  throw new Error(`ci-results.json not found under ${root}`);
}

async function downloadResultFromLog(options: Required<GateCiOptions>, runId: number): Promise<WorkflowResult> {
  const { stdout } = await execFileAsync("gh", ["run", "view", String(runId), "--repo", options.repository, "--log"], {
    env: { ...process.env, GH_TOKEN: options.token },
    maxBuffer: 1024 * 1024 * 32,
  });
  const marker = "OD_CI_RESULTS_JSON ";
  const payload = stdout
    .split("\n")
    .map((line) => {
      const index = line.indexOf(marker);
      return index >= 0 ? line.slice(index + marker.length).trim() : "";
    })
    .filter((line) => line.length > 0)
    .at(-1);
  if (payload == null) {
    throw new Error(`OD_CI_RESULTS_JSON marker not found in run ${runId} logs`);
  }
  return parseWorkflowResult(JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
}

async function downloadResultArtifact(
  options: Required<GateCiOptions>,
  provider: Provider,
  runId: number,
): Promise<WorkflowResult> {
  const dir = await mkdtemp(join(tmpdir(), `od-ci-${provider}-`));
  try {
    await execFileAsync(
      "gh",
      ["run", "download", String(runId), "--repo", options.repository, "--name", `ci-results-${provider}`, "--dir", dir],
      { env: { ...process.env, GH_TOKEN: options.token } },
    );
    const resultPath = await findResultFile(dir);
    return parseWorkflowResult(JSON.parse(await readFile(resultPath, "utf8")));
  } catch {
    process.stderr.write(`artifact download failed for ${provider} run ${runId}; falling back to structured log payload\n`);
    return await downloadResultFromLog(options, runId);
  }
}

function validateIdentity(options: {
  explicitRunId: string;
  provider: Provider;
  result: WorkflowResult;
  targetEvent: string;
  targetSha: string;
}): void {
  if (options.result.provider !== options.provider) {
    throw new Error(`expected provider ${options.provider}, got ${options.result.provider}`);
  }
  if (options.result.headSha !== options.targetSha) {
    throw new Error(`${options.provider} result headSha ${options.result.headSha} does not match target ${options.targetSha}`);
  }
  const skipStrictEventMatch = options.targetEvent === "workflow_dispatch" && options.explicitRunId.length > 0;
  if (!skipStrictEventMatch && options.result.eventName !== options.targetEvent && options.result.eventName !== "workflow_dispatch") {
    throw new Error(`${options.provider} result event ${options.result.eventName} does not match target ${options.targetEvent}`);
  }
}

async function appendSummary(summaryPath: string, lines: string[]): Promise<void> {
  if (summaryPath.length === 0) return;
  await appendFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

export async function gateCi(rawOptions: GateCiOptions): Promise<GateCiResult> {
  const options = gateOptionsWithDefaults(rawOptions);
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error(`timeoutSeconds must be positive: ${options.timeoutSeconds}`);
  }
  if (!Number.isFinite(options.pollIntervalSeconds) || options.pollIntervalSeconds <= 0) {
    throw new Error(`pollIntervalSeconds must be positive: ${options.pollIntervalSeconds}`);
  }
  const manifest = await loadAtomManifest(resolve(options.manifestPath));
  let targetSha = options.targetSha;
  let targetEvent = options.targetEvent;
  if (targetSha.length === 0 || targetEvent.length === 0) {
    const seedRunId = options.ownedRunId || options.githubRunId;
    if (seedRunId.length === 0) {
      throw new Error("targetSha and targetEvent are required unless an ownedRunId or githubRunId is provided");
    }
    const seedRun = await fetchRunById(options, seedRunId);
    targetSha ||= seedRun.head_sha;
    targetEvent ||= seedRun.event;
  }

  const ownedRun = await waitForRun(options, options.ownedWorkflow, options.ownedRunId, targetSha, targetEvent);
  const githubRun = await waitForRun(options, options.githubWorkflow, options.githubRunId, targetSha, targetEvent);
  const ownedResult = await downloadResultArtifact(options, "owned", ownedRun.id);
  const githubResult = await downloadResultArtifact(options, "github", githubRun.id);

  validateIdentity({
    explicitRunId: options.ownedRunId,
    provider: "owned",
    result: ownedResult,
    targetEvent,
    targetSha,
  });
  validateIdentity({
    explicitRunId: options.githubRunId,
    provider: "github",
    result: githubResult,
    targetEvent,
    targetSha,
  });
  validateWorkflowResultAgainstManifest(ownedResult, { manifest, provider: "owned" });
  validateWorkflowResultAgainstManifest(githubResult, { manifest, provider: "github" });

  const aggregate = aggregateWorkflowResults(ownedResult, githubResult);
  const summaryLines = [
    "## CI Gate",
    "",
    `Target SHA: \`${targetSha}\``,
    `Target event: \`${targetEvent}\``,
    `Owned run: [${ownedRun.id}](${ownedRun.html_url}) conclusion=\`${ownedRun.conclusion ?? "null"}\``,
    `GitHub-hosted run: [${githubRun.id}](${githubRun.html_url}) conclusion=\`${githubRun.conclusion ?? "null"}\` mode=\`${githubResult.mode}\``,
    "",
    "| Action | Result | Reason |",
    "| --- | --- | --- |",
    ...aggregate.actions.map((action) => `| \`${action.action}\` | ${action.passed ? "pass" : "fail"} | ${action.reason} |`),
  ];

  await appendSummary(options.summaryPath, summaryLines);
  return {
    githubResult,
    githubRun,
    ownedResult,
    ownedRun,
    passed: aggregate.passed,
    summaryLines,
  };
}
