import type { AgentDiagnostic } from './registry.js';
import type { ConnectionTestResponse } from './connectionTest.js';

/**
 * Status of a single health-check step, mapped to the red/yellow/green
 * checklist the Settings panel renders:
 * - `pass`  → green: the step succeeded.
 * - `warn`  → yellow: usable but degraded / unverified (e.g. auth status
 *   could not be confirmed).
 * - `fail`  → red: blocking; the agent can't be used until it's fixed.
 * - `skip`  → grey: not run because an earlier step already failed (e.g. the
 *   smoke test is pointless when the binary isn't on PATH).
 */
export type AgentHealthStatus = 'pass' | 'warn' | 'fail' | 'skip';

/**
 * The ordered checklist steps. Stable ids so the UI can localize labels and
 * the CLI can key `--json` output without parsing prose.
 */
export type AgentHealthCheckId =
  /** Binary resolved on PATH or via a configured `*_BIN` override. */
  | 'detected'
  /** The resolved binary actually runs (`--version` probe succeeded). */
  | 'invocable'
  /** The CLI reports an authenticated session (when it exposes a probe). */
  | 'authenticated'
  /** A live round-trip prompt returned a usable reply. */
  | 'smoke';

export interface AgentHealthCheckItem {
  id: AgentHealthCheckId;
  status: AgentHealthStatus;
  /** Daemon-authored, single-line summary (English, like AgentDiagnostic). */
  label: string;
  /** Optional longer context (probe stderr tail, smoke failure detail, …). */
  detail?: string;
  /**
   * The actionable diagnostic for a `warn`/`fail` step, reusing the same
   * {@link AgentDiagnostic} contract as detection so the panel can render the
   * shared fix affordances (Install / Docs / Rescan / Sign in / …).
   */
  diagnostic?: AgentDiagnostic;
}

/**
 * Aggregate result of `POST /api/agents/:id/healthcheck` and the
 * `od agent healthcheck <id> --json` CLI. Orchestrates detection diagnostics
 * (PATH / executable / auth) plus an optional live smoke test into one
 * red/yellow/green report.
 */
export interface AgentHealthCheckResult {
  agentId: string;
  agentName: string;
  available: boolean;
  version?: string | null;
  /** Worst-of the checklist: `fail` if any step failed, else `warn`, else `pass`. */
  overall: Exclude<AgentHealthStatus, 'skip'>;
  checks: AgentHealthCheckItem[];
  /** Raw smoke-test response when the smoke step ran (omitted when skipped). */
  smoke?: ConnectionTestResponse;
  /** ISO-8601 timestamp of when the check completed. */
  ranAt: string;
}

export interface AgentHealthCheckRequest {
  /** Model to use for the smoke prompt; falls back to the agent default. */
  model?: string;
  /** Reasoning option id for the smoke prompt, when the agent supports it. */
  reasoning?: string;
  /**
   * Skip the live smoke test and report only detection/auth checks. Defaults
   * to `false` (smoke test runs when the binary is invocable).
   */
  skipSmoke?: boolean;
}
