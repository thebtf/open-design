import assert from "node:assert/strict";
import test from "node:test";

import { aggregateWorkflowResults, parseWorkflowResult } from "../src/aggregate.js";

test("aggregateWorkflowResults passes an atom when either provider has a real success", () => {
  const runner = parseWorkflowResult({
    schemaVersion: 1,
    provider: "runner",
    mode: "default",
    eventName: "workflow_dispatch",
    headSha: "abc",
    runId: "1",
    runAttempt: "1",
    actions: [
      { action: "nix", kind: "placeholder", status: "not-run" },
      { action: "guard", kind: "real", status: "success" },
    ],
  });
  const hosted = parseWorkflowResult({
    schemaVersion: 1,
    provider: "hosted",
    mode: "full",
    eventName: "workflow_dispatch",
    headSha: "abc",
    runId: "2",
    runAttempt: "1",
    actions: [
      { action: "nix", kind: "real", status: "success" },
      { action: "guard", kind: "placeholder", status: "not-run" },
    ],
  });

  const result = aggregateWorkflowResults(runner, hosted);
  assert.equal(result.passed, true);
  assert.deepEqual(result.actions.map((entry) => [entry.action, entry.passed]), [
    ["guard", true],
    ["nix", true],
  ]);
});

test("aggregateWorkflowResults fails when no provider has a real success", () => {
  const runner = parseWorkflowResult({
    schemaVersion: 1,
    provider: "runner",
    mode: "default",
    eventName: "workflow_dispatch",
    headSha: "abc",
    runId: "1",
    runAttempt: "1",
    actions: [
      { action: "nix", kind: "placeholder", status: "not-run" },
    ],
  });
  const hosted = parseWorkflowResult({
    schemaVersion: 1,
    provider: "hosted",
    mode: "full",
    eventName: "workflow_dispatch",
    headSha: "abc",
    runId: "2",
    runAttempt: "1",
    actions: [
      { action: "nix", kind: "real", status: "failure" },
    ],
  });

  const result = aggregateWorkflowResults(runner, hosted);
  assert.equal(result.passed, false);
  assert.equal(result.actions[0]?.reason, "real results but no success (hosted:failure)");
});

test("aggregateWorkflowResults handles the current nine-atom ci-gate shape", () => {
  const atomNames = ["nix", "guard", "i18n", "unit", "typecheck", "daemon", "web", "build", "browser"];
  const runner = parseWorkflowResult({
    schemaVersion: 1,
    provider: "runner",
    mode: "default",
    eventName: "workflow_dispatch",
    headSha: "abc",
    runId: "1",
    runAttempt: "1",
    actions: atomNames.map((action) => action === "nix"
      ? { action, kind: "placeholder", status: "not-run" }
      : { action, kind: "real", status: "success", steps: [{ name: `${action}-step`, durationMs: 1, status: "success" }] }),
  });
  const hosted = parseWorkflowResult({
    schemaVersion: 1,
    provider: "hosted",
    mode: "nix",
    eventName: "workflow_dispatch",
    headSha: "abc",
    runId: "2",
    runAttempt: "1",
    actions: atomNames.map((action) => action === "nix"
      ? { action, kind: "real", status: "success", steps: [{ name: "flake-check", durationMs: 1, status: "success" }] }
      : { action, kind: "placeholder", status: "not-run" }),
  });

  const result = aggregateWorkflowResults(runner, hosted);
  assert.equal(result.passed, true);
  assert.deepEqual(result.actions.map((entry) => entry.action), [...atomNames].sort());
  assert.equal(result.actions.find((entry) => entry.action === "nix")?.reason, "success via hosted");
  assert.equal(result.actions.find((entry) => entry.action === "browser")?.reason, "success via runner");
});
