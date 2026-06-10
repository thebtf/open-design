import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SIDECAR_MESSAGES } from "@open-design/sidecar-proto";
import { describe, expect, it, vi } from "vitest";

import type { ToolPackConfig } from "../src/config.js";

const requestJsonIpc = vi.hoisted(() => vi.fn());

vi.mock("@open-design/sidecar", async () => {
  const actual = await vi.importActual<typeof import("@open-design/sidecar")>("@open-design/sidecar");
  return {
    ...actual,
    requestJsonIpc,
  };
});

const { inspectPackedWinApp } = await import("../src/win/lifecycle.js");

function createConfig(root: string): ToolPackConfig {
  return {
    appVersion: "0.10.0-beta.1",
    containerized: false,
    electronBuilderCliPath: "electron-builder",
    electronDistPath: "electron-dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "test",
    platform: "win",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    requireVelaCli: false,
    roots: {
      cacheRoot: join(root, ".cache"),
      output: {
        appBuilderRoot: join(root, "out", "builder"),
        namespaceRoot: join(root, "out", "win", "namespaces", "test"),
        platformRoot: join(root, "out", "win"),
        root: join(root, "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, "runtime", "win", "namespaces"),
        namespaceRoot: join(root, "runtime", "win", "namespaces", "test"),
      },
      toolPackRoot: join(root, "tools-pack"),
    },
    signed: false,
    silent: true,
    to: "dir",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

describe("inspectPackedWinApp", () => {
  it("returns status and diagnostics when eval IPC times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));

    try {
      requestJsonIpc.mockReset();
      requestJsonIpc.mockImplementation(async (_ipc: string, payload: { type?: string }) => {
        if (payload.type === SIDECAR_MESSAGES.STATUS) {
          return { state: "running", url: "od://app/" };
        }
        if (payload.type === SIDECAR_MESSAGES.EVAL) {
          throw new Error("IPC request timed out: test-pipe");
        }
        throw new Error(`unexpected IPC message: ${String(payload.type)}`);
      });

      const result = await inspectPackedWinApp(createConfig(root), { expr: "document.title" });

      expect(result.status).toEqual({ state: "running", url: "od://app/" });
      expect(result.eval).toEqual({
        error: "IPC request timed out: test-pipe",
        ok: false,
      });
      expect(result.launcher.exists).toBe(false);
      expect(result.updateCache.releaseCount).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
