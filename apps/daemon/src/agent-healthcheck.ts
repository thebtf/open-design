import type {
  AgentCliEnvPrefs,
  AgentDiagnostic,
  AgentHealthCheckItem,
  AgentHealthCheckResult,
  AgentHealthStatus,
  ConnectionTestResponse,
} from '@open-design/contracts';
import { detectAgent } from './runtimes/detection.js';
import { testAgentConnection } from './connectionTest.js';

export interface RunHealthCheckOptions {
  /** Model id for the smoke prompt; falls back to the agent default. */
  model?: string;
  /** Reasoning option id for the smoke prompt, when supported. */
  reasoning?: string;
  /** Skip the live smoke test (detection/auth checks only). */
  skipSmoke?: boolean;
  /** Full per-agent CLI env prefs (same shape as app config `agentCliEnv`). */
  agentCliEnv?: AgentCliEnvPrefs;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the real smoke test. */
  smokeTest?: typeof testAgentConnection;
}

// Detection attaches at most one diagnostic per failure mode. Split them by the
// checklist step each one belongs to so a step can carry its own fix actions.
function pickDiagnostic(
  diagnostics: AgentDiagnostic[] | undefined,
  reasons: AgentDiagnostic['reason'][],
): AgentDiagnostic | undefined {
  return (diagnostics ?? []).find((d) => reasons.includes(d.reason));
}

// `fail` dominates `warn` dominates `pass`; `skip` never raises the overall.
function worst(items: AgentHealthCheckItem[]): Exclude<AgentHealthStatus, 'skip'> {
  if (items.some((i) => i.status === 'fail')) return 'fail';
  if (items.some((i) => i.status === 'warn')) return 'warn';
  return 'pass';
}

// Build a checklist item, omitting optional fields entirely when absent so the
// shape stays clean under `exactOptionalPropertyTypes` (no explicit undefined).
function item(
  id: AgentHealthCheckItem['id'],
  status: AgentHealthStatus,
  label: string,
  extra?: { detail?: string | undefined; diagnostic?: AgentDiagnostic | undefined },
): AgentHealthCheckItem {
  return {
    id,
    status,
    label,
    ...(extra?.detail ? { detail: extra.detail } : {}),
    ...(extra?.diagnostic ? { diagnostic: extra.diagnostic } : {}),
  };
}

/**
 * Orchestrate a single agent's health check: fresh detection (PATH /
 * executable / auth diagnostics) plus an optional live smoke test, folded into
 * an ordered red/yellow/green checklist. Returns `null` for an unknown agent id
 * so the caller can map it to a 404.
 */
export async function runAgentHealthCheck(
  agentId: string,
  opts: RunHealthCheckOptions = {},
): Promise<AgentHealthCheckResult | null> {
  const configuredEnv = opts.agentCliEnv?.[agentId] ?? {};
  const agent = await detectAgent(agentId, configuredEnv);
  if (!agent) return null;

  const diags = agent.diagnostics;
  const execDiag = pickDiagnostic(diags, ['not-on-path', 'configured-bin-invalid']);
  const invocDiag = pickDiagnostic(diags, ['shim-broken', 'not-executable']);
  const authDiag = pickDiagnostic(diags, ['auth-missing', 'auth-unknown']);

  const checks: AgentHealthCheckItem[] = [];

  // 1) detected — did executable resolution find a binary?
  if (execDiag) {
    checks.push(
      item('detected', 'fail', execDiag.message, {
        detail: execDiag.detail,
        diagnostic: execDiag,
      }),
    );
  } else {
    checks.push(
      item(
        'detected',
        'pass',
        agent.path
          ? `${agent.name} found at ${agent.path}`
          : `${agent.name} (\`${agent.bin}\`) found on PATH`,
      ),
    );
  }

  // 2) invocable — does the resolved binary actually run?
  if (execDiag) {
    checks.push(item('invocable', 'skip', 'Skipped — binary not found.'));
  } else if (invocDiag) {
    checks.push(
      item('invocable', 'fail', invocDiag.message, {
        detail: invocDiag.detail,
        diagnostic: invocDiag,
      }),
    );
  } else if (agent.available) {
    checks.push(
      item(
        'invocable',
        'pass',
        agent.version ? `Runs OK (v${agent.version})` : 'Runs OK',
      ),
    );
  } else {
    checks.push(item('invocable', 'fail', `${agent.name} could not be launched.`));
  }

  // 3) authenticated — only meaningful once the binary runs.
  if (!agent.available) {
    checks.push(item('authenticated', 'skip', 'Skipped — agent not runnable.'));
  } else if (agent.authStatus === 'ok') {
    checks.push(item('authenticated', 'pass', agent.authMessage ?? 'Authenticated.'));
  } else if (agent.authStatus === 'missing') {
    checks.push(
      item(
        'authenticated',
        'fail',
        agent.authMessage ?? `${agent.name} is not signed in.`,
        { diagnostic: authDiag },
      ),
    );
  } else if (agent.authStatus === 'unknown') {
    checks.push(
      item(
        'authenticated',
        'warn',
        agent.authMessage ?? `${agent.name} auth status could not be verified.`,
        { diagnostic: authDiag },
      ),
    );
  } else {
    // No auth probe declared for this agent (e.g. API-key-only CLIs).
    checks.push(item('authenticated', 'skip', 'No sign-in step for this agent.'));
  }

  // 4) smoke — a live round-trip, the strongest signal the agent is usable.
  let smoke: ConnectionTestResponse | undefined;
  if (!agent.available) {
    checks.push(item('smoke', 'skip', 'Skipped — agent not runnable.'));
  } else if (opts.skipSmoke) {
    checks.push(item('smoke', 'skip', 'Skipped.'));
  } else {
    const run = opts.smokeTest ?? testAgentConnection;
    smoke = await run({
      agentId,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.agentCliEnv ? { agentCliEnv: opts.agentCliEnv } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (smoke.ok) {
      checks.push(item('smoke', 'pass', `Live reply OK (${smoke.latencyMs}ms).`));
    } else {
      // An auth_required smoke failure is fixable the same way the auth check
      // is, so reuse that diagnostic's fix actions when we have one.
      checks.push(
        item('smoke', 'fail', smoke.detail ?? `Smoke test failed (${smoke.kind}).`, {
          detail: smoke.detail,
          diagnostic: smoke.kind === 'agent_auth_required' ? authDiag : undefined,
        }),
      );
    }
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    available: agent.available,
    version: agent.version ?? null,
    overall: worst(checks),
    checks,
    ...(smoke ? { smoke } : {}),
    ranAt: new Date().toISOString(),
  };
}
