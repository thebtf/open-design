import { test } from 'vitest';
import {
  assert,
  chmodSync,
  join,
  mkdtempSync,
  rmSync,
  tmpdir,
  withEnvSnapshot,
  writeFileSync,
} from './runtimes/helpers/test-helpers.js';
import { runAgentHealthCheck } from '../src/agent-healthcheck.js';
import type { ConnectionTestResponse } from '@open-design/contracts';

const posixTest = process.platform === 'win32' ? test.skip : test;

function writeCursorAgent(dir: string, statusOutput: string): void {
  const bin = join(dir, 'cursor-agent');
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo "2026.05.07-test"; exit 0; fi\n` +
      `if [ "$1" = "models" ]; then echo "auto"; exit 0; fi\n` +
      `if [ "$1" = "status" ]; then echo "${statusOutput}"; exit 0; fi\n` +
      `exit 0\n`,
  );
  chmodSync(bin, 0o755);
}

function stubSmoke(ok: boolean): () => Promise<ConnectionTestResponse> {
  return async () =>
    ok
      ? { ok: true, kind: 'success', latencyMs: 12, sample: 'ok' }
      : { ok: false, kind: 'agent_auth_required', latencyMs: 8, detail: 'sign in first' };
}

posixTest('runAgentHealthCheck reports green when detected, authed, and smoke passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-hc-ok-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      writeCursorAgent(dir, 'Authenticated');
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      const result = await runAgentHealthCheck('cursor-agent', {
        smokeTest: stubSmoke(true) as never,
      });
      assert.ok(result, 'expected a result for a known agent');
      assert.equal(result?.overall, 'pass');
      assert.equal(result?.available, true);
      const byId = Object.fromEntries(
        (result?.checks ?? []).map((c) => [c.id, c.status]),
      );
      assert.equal(byId.detected, 'pass');
      assert.equal(byId.invocable, 'pass');
      assert.equal(byId.authenticated, 'pass');
      assert.equal(byId.smoke, 'pass');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

posixTest('runAgentHealthCheck fails the detected step and skips the rest when off PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-hc-missing-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      // cursor-agent only — gemini is not installed anywhere on PATH.
      writeCursorAgent(dir, 'Authenticated');
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      const result = await runAgentHealthCheck('gemini', { skipSmoke: true });
      assert.ok(result);
      assert.equal(result?.overall, 'fail');
      assert.equal(result?.available, false);
      const detected = result?.checks.find((c) => c.id === 'detected');
      assert.equal(detected?.status, 'fail');
      assert.equal(detected?.diagnostic?.reason, 'not-on-path');
      const invocable = result?.checks.find((c) => c.id === 'invocable');
      assert.equal(invocable?.status, 'skip');
      const smoke = result?.checks.find((c) => c.id === 'smoke');
      assert.equal(smoke?.status, 'skip');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

posixTest('runAgentHealthCheck fails the auth step when the CLI is signed out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-hc-auth-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      writeCursorAgent(dir, 'Not authenticated');
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      const result = await runAgentHealthCheck('cursor-agent', { skipSmoke: true });
      assert.ok(result);
      const auth = result?.checks.find((c) => c.id === 'authenticated');
      assert.equal(auth?.status, 'fail');
      assert.equal(auth?.diagnostic?.reason, 'auth-missing');
      assert.equal(result?.overall, 'fail');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgentHealthCheck returns null for an unknown agent id', async () => {
  const result = await runAgentHealthCheck('does-not-exist');
  assert.equal(result, null);
});
