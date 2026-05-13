---
id: 20260513-unify-agent-runtime-abstraction
name: Unify Agent Runtime Abstraction
status: researched
created: '2026-05-13'
---

## Overview

### Problem Statement

- Agent runtime 差异目前仍暴露到上层调用路径中，上层模块仍可能需要感知具体 runtime 的协议、事件格式、parser、handler、stdout 形态或能力差异。
- 一个已知例子：`server.ts` 中对 `claude-stream-json`、`qoder-stream-json`、`copilot-stream-json`、`pi-rpc`、`acp-json-rpc`、`json-event-stream` 和 plain stdout 的显式处理。

### Goals

- 重构代码，统一 agent runtime 抽象。
- 将不同 agent runtime 的差异性封装到底层模块中。
- 让上层逻辑无需感知具体 runtime 的协议、parser、handler、事件格式或输出形态。

### Success Criteria

- 上层入口基于统一 runtime 定义调度 agent。
- 新增或调整 agent runtime 时，主要改动集中在底层 runtime 定义或适配模块。
- `server.ts` 和其他上层模块不再承担按具体 runtime、协议、parser、handler 或输出格式分支的职责。

## Research

### Existing System

- Agent runtime definitions live in `apps/daemon/src/runtimes/defs/*` and are aggregated by `AGENT_DEFS`; each definition declares `streamFormat`, plus runtime-specific fields such as `promptViaStdin`, `eventParser`, `supportsImagePaths`, and prompt-size limits. Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/runtimes/registry.ts:19-36`
- Current runtime formats are encoded as string values on definitions: Claude, Qoder, Copilot, JSON-event streams, ACP JSON-RPC, Pi RPC, and plain stdout. Source: `apps/daemon/src/runtimes/defs/claude.ts:68-69`, `apps/daemon/src/runtimes/defs/qoder.ts:56-57`, `apps/daemon/src/runtimes/defs/copilot.ts:68-69`, `apps/daemon/src/runtimes/defs/codex.ts:79-81`, `apps/daemon/src/runtimes/defs/gemini.ts:35-37`, `apps/daemon/src/runtimes/defs/hermes.ts:26-28`, `apps/daemon/src/runtimes/defs/pi.ts:88-94`, `apps/daemon/src/runtimes/defs/deepseek.ts:44-54`
- `/api/chat` orchestration in `server.ts` uses `def.streamFormat` for prompt composition, MCP routing, stdin mode, stdin write behavior, SSE start metadata, critique eligibility, stream handler dispatch, Pi/ACP session storage, empty-output handling, and close-status mapping. Source: `apps/daemon/src/server.ts:3093-3125,3383-3390,3583-3586,3790-3794,3811-3814,3843-3860,3938-3944,4080-4176,4192-4264`
- Stream parsing is already partially modular: Claude, Qoder, Copilot, JSON-event, Pi RPC, and ACP each expose parser/session helpers that translate runtime-specific output into daemon events. Source: `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/qoder-stream.ts:1-6,62`, `apps/daemon/src/copilot-stream.ts:1-22,31`, `apps/daemon/src/json-event-stream.ts:376-420`, `apps/daemon/src/pi-rpc.ts:337-379`, `apps/daemon/src/acp.ts:398-458`
- The connection-test path has a second runtime dispatch tree that mirrors the chat path for stream handlers, stdin mode, Pi/ACP sessions, and prompt writes. Source: `apps/daemon/src/connectionTest.ts:901-968,1126-1167,1197-1220,1284-1292`
- Plain stdout is special today: the prompt composer inserts API-mode override only when `streamFormat === 'plain'`, and the chat stream path forwards raw stdout chunks on the `stdout` SSE channel. Source: `apps/daemon/src/prompts/system.ts:258-267`, `apps/daemon/src/server.ts:4168-4172`

### Available Approaches

- **Central runtime adapter table**: keep current `RuntimeAgentDef` metadata, add a resolved runtime adapter object keyed by format or attached to the definition, and move stream/session attachment plus stdin prompt behavior out of `server.ts` and `connectionTest.ts`. Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- **Definition-owned runtime behavior**: extend each runtime definition with behavior hooks for spawn IO, stream attachment, prompt delivery, and completion semantics, so adding a runtime happens primarily in its definition module. Source: `apps/daemon/src/runtimes/registry.ts:19-36`, `apps/daemon/src/runtimes/defs/pi.ts:88-94`, `apps/daemon/src/runtimes/defs/deepseek.ts:44-54`
- **Shared attach helper used by chat and connection tests**: extract the duplicated stream/session dispatch into a daemon runtime module consumed by both `/api/chat` and connection tests. Source: `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- **Two-layer model**: keep process launch/env/args in runtime definitions and put protocol/session handling in lower-level adapter helpers, matching the existing split between `defs/*` and parser/session modules. Source: `apps/daemon/src/runtimes/defs/claude.ts:60-69`, `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/acp.ts:398-458`

### Constraints & Dependencies

- The unified abstraction must preserve the existing daemon event contract: structured handlers emit `agent` events, plain streams emit `stdout`, errors emit `error`, and run completion emits `end`. Source: `apps/daemon/src/runs.ts:49-89`, `apps/daemon/src/server.ts:4061-4078,4168-4172,4264`
- Pi RPC and ACP sessions are cancellation/completion-aware and are stored on `run.acpSession` so cancellation and close handling can call session methods instead of relying only on raw process signals. Source: `apps/daemon/src/server.ts:4101-4176,4196-4241`
- Some stream formats need special failure semantics: Qoder, Pi RPC, and JSON-event streams route through `sendAgentEvent` so structured error frames and empty-output runs become failed chat runs. Source: `apps/daemon/src/server.ts:4088-4092,4101-4142,4155-4167,4196-4223`
- Critique Theater currently only supports plain stdout and explicitly skips structured formats, so any abstraction must keep this eligibility decision visible or move it into runtime capabilities. Source: `apps/daemon/src/server.ts:3079-3098,3923-3944`
- External MCP wiring differs by runtime: Claude writes `.mcp.json`, while ACP runtimes receive MCP server descriptors through the ACP session. Source: `apps/daemon/src/server.ts:3515-3586`
- Existing parser/session coverage lives in daemon tests and should remain the red/green safety net for behavior-preserving refactors. Source: `apps/daemon/tests/structured-streams.test.ts:1-10`, `apps/daemon/tests/qoder-stream.test.ts:1-18`, `apps/daemon/tests/json-event-stream.test.ts:1-14`, `apps/daemon/tests/pi-rpc.test.ts:1-10`, `apps/daemon/tests/acp.test.ts:1-10`

### Key References

- `apps/daemon/src/server.ts:3141-4269` - main `/api/chat` run setup, spawn, stream/session dispatch, and completion handling.
- `apps/daemon/src/connectionTest.ts:901-1292` - duplicated runtime dispatch path for agent connection tests.
- `apps/daemon/src/runtimes/types.ts:37-68` - runtime definition shape and existing capability fields.
- `apps/daemon/src/runtimes/registry.ts:19-48` - runtime definition registry and duplicate-id guard.
- `apps/daemon/src/json-event-stream.ts:394-399` - shared JSON-event parser selects sub-parser by runtime kind.
- `apps/daemon/src/pi-rpc.ts:337-379` and `apps/daemon/src/acp.ts:398-458` - session-based runtime adapters with fatal-error handling.

## Design

<!-- Technical approach, architecture decisions, and test strategy. Each design decision should cite a fact source. -->

## Plan

<!-- Optional: Step breakdown for complex features that need multiple implementation steps.
     Decided during Design. Checked off during Implement.
     Keep this section compact and step-based.
     Use markdown checkboxes for all step and substep items, for example:
     - [ ] Step 1: Foo
       - [ ] Substep 1.1 Implement: Foo foundation
       - [ ] Substep 1.2 Implement: Foo integration
       - [ ] Substep 1.3 Implement: Foo edge handling
       - [ ] Substep 1.4 Verify: Foo automated coverage
       - [ ] Substep 1.5 Verify: Foo manual workflow
     - [ ] Step 2: Bar
       - [ ] Substep 2.1 Implement: Bar
       - [ ] Substep 2.2 Verify: Bar
     - [ ] Step 3: Baz
       - [ ] Substep 3.1 Implement: Baz
       - [ ] Substep 3.2 Verify: Baz
     Use a capability-based step breakdown with reviewable, meaningful increments.
     Good boundaries align with one user-visible workflow, one subsystem/integration boundary, one migration/rollout step, or one stabilization milestone.
     Each step must include small, independent substeps for implementation and immediate testing/verification.
     Within each step, list implementation substeps before verification substeps.
     The final step may focus on overall testing/verification, edge cases, regression coverage, and coverage improvements.
     A step is complete only when relevant tests pass.
     Size steps so one coding agent can implement + validate in a single session.
     Write each substep as one small, independent task. -->

## Notes

<!-- Optional sections — add what's relevant. -->

### Implementation

<!-- Files created/modified, decisions made during coding, deviations from design -->

### Verification

<!-- How the feature was verified: tests written, manual testing steps, results -->
