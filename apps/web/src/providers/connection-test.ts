// Thin POST-and-decode wrappers around the daemon's /api/test/connection route.
// The daemon always answers with HTTP 200 and a `ConnectionTestResponse`
// body even on upstream-caused failures, so the only paths that throw here
// are network-level errors and abort signals.

import type {
  AgentHealthCheckRequest,
  AgentHealthCheckResult,
  AgentTestRequest,
  ConnectionTestRequest,
  ConnectionTestResponse,
  ProviderTestRequest,
} from '../types';

function requestModel(body: ConnectionTestRequest): string | undefined {
  const model = (body as { model?: unknown }).model;
  if (typeof model === 'string' && model.trim()) return model.trim();
  return body.mode === 'agent' ? 'default' : undefined;
}

async function postTest(
  body: ConnectionTestRequest,
  signal?: AbortSignal,
): Promise<ConnectionTestResponse> {
  const start = Date.now();
  try {
    const response = await fetch('/api/test/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const payload = (await response.json()) as
          | { error?: { message?: string }; message?: string }
          | null;
        detail = payload?.error?.message ?? payload?.message;
      } catch {
        // body was not JSON — keep detail undefined.
      }
      return {
        ok: false,
        kind: 'unknown',
        latencyMs: Date.now() - start,
        model: requestModel(body),
        detail: detail ?? `Daemon responded with ${response.status}`,
      };
    }
    return (await response.json()) as ConnectionTestResponse;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return {
      ok: false,
      kind: 'unknown',
      latencyMs: Date.now() - start,
      model: requestModel(body),
      detail: err instanceof Error ? err.message : 'Network request failed',
    };
  }
}

export function testApiProvider(
  input: ProviderTestRequest,
  signal?: AbortSignal,
): Promise<ConnectionTestResponse> {
  return postTest({ mode: 'provider', ...input }, signal);
}

export function testAgent(
  input: AgentTestRequest,
  signal?: AbortSignal,
): Promise<ConnectionTestResponse> {
  return postTest({ mode: 'agent', ...input }, signal);
}

// Run the per-agent configuration health check (detection diagnostics + an
// optional live smoke test). Mirrors `postTest`'s contract: aborts re-throw,
// everything else resolves to an AgentHealthCheckResult so the panel always
// has a checklist to render — a transport failure surfaces as a single failed
// `detected` row rather than an exception the card has to catch.
export async function healthcheckAgent(
  agentId: string,
  input: AgentHealthCheckRequest = {},
  signal?: AbortSignal,
): Promise<AgentHealthCheckResult> {
  const failResult = (label: string): AgentHealthCheckResult => ({
    agentId,
    agentName: agentId,
    available: false,
    overall: 'fail',
    checks: [{ id: 'detected', status: 'fail', label }],
    ranAt: new Date().toISOString(),
  });
  try {
    const response = await fetch(
      `/api/agents/${encodeURIComponent(agentId)}/healthcheck`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      },
    );
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const payload = (await response.json()) as
          | { error?: { message?: string }; message?: string }
          | null;
        detail = payload?.error?.message ?? payload?.message;
      } catch {
        // body was not JSON — keep detail undefined.
      }
      return failResult(detail ?? `Daemon responded with ${response.status}`);
    }
    return (await response.json()) as AgentHealthCheckResult;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return failResult(err instanceof Error ? err.message : 'Network request failed');
  }
}
