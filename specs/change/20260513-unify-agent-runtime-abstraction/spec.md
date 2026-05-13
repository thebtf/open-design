---
id: 20260513-unify-agent-runtime-abstraction
name: Unify Agent Runtime Abstraction
status: designed
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

- 上层入口基于统一 `RuntimeAdapter` 调度 agent。
- `RuntimeAgentDef` 不再作为上层 runtime 抽象暴露；如果保留它能减少 churn，它可以继续作为 runtime 包内部实现细节存在。
- 默认保留现有 `apps/daemon/src/runtimes/defs/*` 文件结构；不得为了匹配新抽象而批量移动文件、重命名符号或整理相邻代码。
- 新增或调整 agent runtime 时，主要改动集中在底层 runtime adapter 或协议适配模块。
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

- **Adapter public boundary over existing definitions**: expose `getRuntimeAdapter(agentId)` to upper daemon modules, wrap existing `RuntimeAgentDef` entries and protocol helpers behind adapter methods, and keep definitions internal unless a narrower change requires removal. Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/server.ts:3181-3189,4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- **Definition-owned runtime behavior**: extend each runtime definition with behavior hooks for spawn IO, stream attachment, prompt delivery, and completion semantics. Rejected as the public boundary because it risks keeping definitions in orchestration paths; individual adapter implementations may still compose existing definitions internally to avoid churn. Source: `apps/daemon/src/runtimes/registry.ts:19-36`, `apps/daemon/src/runtimes/defs/pi.ts:88-94`, `apps/daemon/src/runtimes/defs/deepseek.ts:44-54`
- **Shared attach helper used by chat and connection tests**: extract the duplicated stream/session dispatch into a daemon runtime module consumed by both `/api/chat` and connection tests. Source: `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- **Adapter modules with helper composition**: compose adapter methods from existing `defs/*` launch definitions plus parser/session helpers, without moving definitions by default. Source: `apps/daemon/src/runtimes/defs/claude.ts:60-69`, `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/acp.ts:398-458`

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

### Architecture Overview

```mermaid
flowchart TD
  Chat[/api/chat startChatRun] --> Runtime[getRuntimeAdapter(agentId)]
  Conn[connectionTest] --> Runtime
  Runtime --> Adapter[RuntimeAdapter\npublic daemon runtime boundary]
  Adapter --> Launch[spawn/args/env/prompt budget]
  Adapter --> Protocol[protocol parser/session/MCP/prompt delivery]
  Adapter --> Sink[RuntimeSink]
  Sink --> SSE[SSE: agent/stdout/stderr/error/end]
  Adapter --> Close[evaluateClose]
  Close --> Run[run.acpSession\nor run.runtimeSession if needed]
```

采用 adapter public boundary：`server.ts`、`connectionTest.ts` 等上层 daemon 模块只通过 `getRuntimeAdapter(agentId)` 获取 `RuntimeAdapter`；identity、能力、启动、prompt delivery、parser/session 和 close-status 语义通过 `RuntimeAdapter` 暴露。Adapter 实现可以组合现有 `RuntimeAgentDef`、`defs/*`、parser/session helper；除非边界收敛确实需要，默认不移动 runtime definition 文件、不批量重命名符号。

### Change Scope

- Area: daemon runtime public boundary. Impact: 上层从 `getAgentDef(agentId)` 改为 `getRuntimeAdapter(agentId)`；`RuntimeAgentDef` 可保留为 runtime 包内部实现。Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/runtimes/registry.ts:19-48`
- Area: daemon runtime adapter module. Impact: 新增 `apps/daemon/src/runtimes/runtime-adapters.ts`（或同等模块）集中暴露上层实际需要的 identity、capabilities、spawn、parser/session/stdin/prompt/close policy；不迁移无关 detection/model/prompt-budget helper，除非调用边界强制需要。Source: `apps/daemon/src/server.ts:3787-3860,4080-4264`, `apps/daemon/src/connectionTest.ts:901-1292`
- Area: `/api/chat` orchestration. Impact: `server.ts` 保留 run 生命周期、请求校验、SSE sink、诊断和最终状态落库，但不直接读取 runtime launch/protocol fields；这些都由 adapter 方法提供。Source: `apps/daemon/src/server.ts:3181-3189,3787-3860,4061-4264`
- Area: connection tests. Impact: `connectionTest.ts` 复用同一 adapter spawn/attach/evaluateClose 行为，避免第二套 runtime dispatch drift。Source: `apps/daemon/src/connectionTest.ts:901-968,1126-1292`
- Area: prompt composition and critique eligibility. Impact: 用 adapter capability 表达 plain/API prompt mode 与 Critique Theater eligibility，避免上层继续以 `streamFormat === 'plain'` 推断。Source: `apps/daemon/src/prompts/system.ts:258-267`, `apps/daemon/src/server.ts:3079-3098,3923-3944`
- Area: external MCP delivery. Impact: 仅在消除上层 protocol dispatch 必须时迁移 Claude `.mcp.json` 与 ACP MCP descriptors；否则保持现有位置，避免扩大范围。Source: `apps/daemon/src/server.ts:3515-3586`

### Scope Guard

本次变更是 behavior-preserving 的手术式重构。每一行改动都必须能追溯到以下目的之一：移除上层 runtime/protocol dispatch，或让 chat 和 connection test 共享同一 dispatch 路径。文件移动、符号批量重命名、格式化清理、相邻代码整理、完全删除 `RuntimeAgentDef`、完整 capability model 重塑、runtime session 命名清理都默认不在本次范围内。只移除本次改动制造出来的 unused import、unused variable、unused helper。

### Design Decisions

- Decision: 使用 `RuntimeAdapter` 作为 daemon 上层唯一 runtime public boundary；`RuntimeAgentDef` 可继续作为 adapter 内部 launch/metadata record，直到后续独立重构有明确收益。Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/runtimes/registry.ts:19-48`
- Decision: adapter 解析必须 fail fast；`getRuntimeAdapter(agentId)` 找不到 runtime 或 adapter 构造失败时直接失败，不回退到 plain/mock behavior。Source: `apps/daemon/src/runtimes/registry.ts:19-48`, `apps/daemon/src/runtimes/types.ts:50-55`
- Decision: 引入最小 `RuntimeSink`，只承载 chat 和 connection test 共享 attach 路径所需的 `agent`/`stdout`/`stderr`/`error` 发射与必要 state；不要顺手重写无关 SSE 或 activity 逻辑。Source: `apps/daemon/src/server.ts:4061-4078,4088-4167`
- Decision: spawn、stdin mode、prompt delivery、env/args resolution、stream/session attach 和 close policy 属于 adapter 对外能力；image support、prompt budget 等现有 helper 只有在上层边界要求时才迁移。Source: `apps/daemon/src/server.ts:3811-3860,4101-4154,4266-4268`, `apps/daemon/src/connectionTest.ts:1105-1147,1284-1292`
- Decision: session-aware runtimes 可返回统一 `RuntimeSession`，包含 `abort`、`hasFatalError`、`completedSuccessfully` 等能力；实现阶段优先复用现有 `run.acpSession` 存储，只有确有必要才新增 `run.runtimeSession` 兼容字段。Source: `apps/daemon/src/server.ts:4174-4176,4196-4244`, `apps/daemon/src/connectionTest.ts:893-899,1197-1220`
- Decision: close-status policy 由 adapter/session 提供 override；generic close handler 只合并 cancel、exit code、signal、stream error、empty-output guard 与 adapter override。Source: `apps/daemon/src/server.ts:4192-4264`, `apps/daemon/src/connectionTest.ts:1197-1220`
- Decision: prompt-mode、Critique Theater、substantive-output tracking 可逐步改为显式 capabilities；第一轮只替换当前阻塞上层 format dispatch 的检查。Source: `apps/daemon/src/prompts/system.ts:258-267`, `apps/daemon/src/server.ts:3079-3098,3923-3944,4040-4078`
- Decision: 保持现有 SSE contract 不变；structured handlers 继续发 `agent`，plain streams 继续发 `stdout`，错误发 `error`，run 终止发 `end`。Source: `apps/daemon/src/runs.ts:49-89`, `apps/daemon/src/server.ts:4061-4078,4168-4172,4264`
- Decision: 本次重构不改变 Claude external MCP 写入失败的 best-effort 语义；除非必须迁移位置，否则保持现有代码。是否改为 hard failure 另行决策。Source: `apps/daemon/src/server.ts:3515-3586`

### Why this design

- 把 runtime 差异和可见能力都集中到 adapter，直接满足“上层只感知一个 runtime 抽象”的目标。
- 复用同一 adapter 给 chat 和 connection test，减少两条路径行为漂移。
- 保留现有 parser/session 模块和 SSE contract，降低行为保持型重构风险。
- 显式 capability 比 `streamFormat` 字符串推断更可维护，也让 Critique Theater、prompt mode、empty-output guard 等业务决策可审查。

### Test Strategy

- Phase/area: adapter registry. Validation: 每个 runtime id 可通过 `getRuntimeAdapter` 解析 adapter；未知 agent id 抛错或返回 unavailable；禁止 silent plain fallback。Source: `apps/daemon/src/runtimes/registry.ts:19-48`
- Phase/area: adapter attach behavior. Validation: fake child streams 覆盖 Claude/Qoder/Copilot/JSON-event/plain/Pi/ACP 输出到正确 sink channel，stderr 保持 `stderr`。Source: `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- Phase/area: prompt/stdin/session. Validation: plain/stdin runtimes 写 stdin；Pi/ACP 不双写 stdin；Pi/ACP 暴露 fatal/completion/cancel handle。Source: `apps/daemon/src/server.ts:3811-3860,4101-4154,4266-4268`
- Phase/area: close semantics. Validation: Qoder/Pi/JSON-event error frame 标记 failed；tracked structured stream 空输出失败；ACP clean SIGTERM 成功；真实非零退出仍失败。Source: `apps/daemon/src/server.ts:4088-4167,4196-4244`
- Phase/area: upper-boundary guard. Validation: 增加源边界回归测试或 guard，禁止 `server.ts`/`connectionTest.ts` 导入/使用 `getAgentDef`、runtime launch/protocol field access、直接 parser handler imports、直接 `attachAcpSession`/`attachPiRpcSession` 调用。Source: `apps/daemon/src/server.ts:3181-3189,4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- Phase/area: existing regression suites. Validation: 继续运行 `apps/daemon/tests/structured-streams.test.ts`、`qoder-stream.test.ts`、`json-event-stream.test.ts`、`pi-rpc.test.ts`、`acp.test.ts`，以及 `pnpm --filter @open-design/daemon test`、`pnpm --filter @open-design/daemon typecheck`、`pnpm guard`、`pnpm typecheck`。Source: `apps/daemon/tests/structured-streams.test.ts:1-10`, `apps/daemon/tests/qoder-stream.test.ts:1-18`, `apps/daemon/tests/json-event-stream.test.ts:1-14`, `apps/daemon/tests/pi-rpc.test.ts:1-10`, `apps/daemon/tests/acp.test.ts:1-10`

### Upper-layer Call Flow

`server.ts` 仍然拥有 run lifecycle、请求参数校验、SSE、诊断和最终状态落库；它只通过一个入口接触 runtime：`RuntimeAdapter`。

调用流程：

```ts
const runtime = getRuntimeAdapter(agentId);
if (!runtime) failRun('AGENT_UNAVAILABLE');

const critiqueShouldRun = shouldRunCritique(runtime.capabilities, requestContext);

const prompt = composeSystemPrompt({
  ...promptInputs,
  agentId: runtime.id,
  promptMode: runtime.capabilities.promptMode,
  critique: critiqueShouldRun ? critiqueCfg : undefined,
});

await runtime.prepareRun?.(runContext);

const launch = await runtime.spawn({ ...runContext, prompt });

const sink = createRuntimeSink(send, runtime.capabilities);

send('start', { runId, agentId: runtime.id, ...launch.startMetadata });

const attachment = runtime.attach({
  child: launch.child,
  prompt,
  context: runContext,
  sink,
});

run.runtimeSession = attachment.session ?? null;
run.acpSession = attachment.session ?? null; // transition compatibility

runtime.deliverPrompt?.({ child: launch.child, prompt, attachment });

launch.child.on('close', (code, signal) => {
  const decision = runtime.evaluateClose({
    code,
    signal,
    canceled: run.cancelRequested,
    attachment,
    sinkState: sink.state(),
  });

  if (decision.error) {
    send('error', createSseErrorPayload(
      decision.error.code,
      decision.error.message,
      decision.error.options,
    ));
  }

  return design.runs.finish(run, decision.status, decision.code, decision.signal);
});
```

`connectionTest.ts` 使用同一个 `getRuntimeAdapter`、`runtime.spawn`、`runtime.attach`、`runtime.evaluateClose` 模型，但替换 `send`、`sink` 和最终 result mapping 为 connection-test 本地实现；不得维护第二套按 runtime format 分支的 stream/session dispatch。

### File Structure

- `apps/daemon/src/runtimes/types.ts` - add public adapter/session/sink/spawn/close types while preserving `RuntimeAgentDef` if existing internals still need it.
- `apps/daemon/src/runtimes/runtime-adapters.ts` - expose `getRuntimeAdapter(agentId)` and, only if needed by existing callers, `listRuntimeAdapters()`; compose adapters from existing definitions and protocol helpers.
- `apps/daemon/src/runtimes/runtime-sink.ts` - optional normalized sink helpers for chat and connection test usage, only if separating them avoids duplication without rewriting unrelated SSE logic.
- `apps/daemon/src/runtimes/defs/*` - preserve existing files by default; do not move or rename definitions solely to fit the adapter shape.
- `apps/daemon/src/server.ts` - replace `getAgentDef` and format dispatch with adapter calls where needed; keep run lifecycle, SSE wiring, diagnostics, and final status ownership.
- `apps/daemon/src/connectionTest.ts` - replace duplicated stream/session dispatch with shared adapter attach/close behavior; keep local result mapping.
- `apps/daemon/src/prompts/system.ts` and `packages/contracts/src/prompts/system.ts` - update only if removing upper-layer format checks requires explicit prompt mode alignment.
- `apps/daemon/tests/*runtime-adapter*.test.ts` - add focused adapter/sink/registry regression coverage; keep existing parser/session tests as the main safety net.

### Interfaces / APIs

```ts
function getRuntimeAdapter(agentId: string): RuntimeAdapter | null;
function listRuntimeAdapters(): RuntimeAdapterSummary[];

type RuntimeCapabilities = {
  supportsImagePaths: boolean;
  promptMode: 'api-plain' | 'tooling';
  critiqueTheater: boolean;
  tracksSubstantiveOutput: boolean;
};

type RuntimeAdapterSummary = {
  id: string;
  name: string;
  available?: boolean;
  models?: RuntimeModelOption[];
  capabilities: RuntimeCapabilities;
};

type RuntimeSink = {
  agent(ev: unknown): void;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  error(message: string, options?: { retryable?: boolean; details?: unknown }): void;
  activity(summary?: string): void;
};

type RuntimeSession = {
  abort?: () => void;
  hasFatalError?: () => boolean;
  completedSuccessfully?: () => boolean;
};

type RuntimeAttachment = {
  session?: RuntimeSession | null;
  flush?: () => void;
};

type RuntimeSpawnResult = {
  child: ChildProcess;
  resolvedBin: string;
  startMetadata?: Record<string, unknown>;
};

type RuntimeCloseDecision = {
  status: 'succeeded' | 'failed' | 'canceled';
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: {
    code: string;
    message: string;
    options?: { retryable?: boolean; details?: unknown };
  };
};

type RuntimeAdapter = {
  id: string;
  name: string;
  capabilities: RuntimeCapabilities;

  summarize?(): RuntimeAdapterSummary;
  validateOptions?(input: RuntimeOptionInput): RuntimeOptions;
  prepareRun?(ctx: RuntimePrepareContext): Promise<void>;
  spawn(ctx: RuntimeSpawnContext): Promise<RuntimeSpawnResult>;
  attach(ctx: RuntimeAttachContext): RuntimeAttachment;
  deliverPrompt?(ctx: RuntimePromptContext): void;
  evaluateClose(ctx: RuntimeCloseContext): RuntimeCloseDecision;
};
```

### Edge Cases

- Qoder/Pi/JSON-event structured error frame 必须继续使 run failed，不能被当作普通 `agent` event 转发后成功结束。Source: `apps/daemon/src/server.ts:4088-4167,4196-4223`
- Pi/ACP session prompt delivery 与 stdin prompt delivery 互斥，避免 prompt 重复发送或 session 被破坏。Source: `apps/daemon/src/server.ts:3811-3860,4101-4154,4266-4268`
- ACP clean completion 后的 forced SIGTERM 仍应判定 succeeded；其他 signal/non-zero exit 保持 failed。Source: `apps/daemon/src/server.ts:4224-4244`, `apps/daemon/src/connectionTest.ts:1197-1220`
- Plain stdout 继续发 `stdout` 而不是 `agent`，避免改变 web/client event contract。Source: `apps/daemon/src/server.ts:4168-4172`
- `start` event 中的 `streamFormat` 如有客户端依赖可暂时保留为 opaque metadata，但上层代码不得再基于它分支。Source: `apps/daemon/src/server.ts:3787-3799`
- Claude CLI diagnostic tails 仍需从 raw stdout/stderr 捕获，迁移 adapter 时不能丢失诊断输入。Source: `apps/daemon/src/server.ts:3872-3882,4177-4183,4247-4264`
- Adapter 容易膨胀成 god object；第一轮只暴露上层移除 runtime dispatch 所必需的方法。实现时用现有 launch helper、protocol helper、close-policy helper 组合出 adapter，不为了抽象完整性迁移无关 helper。Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/server.ts:3141-4269`

## Plan

- [ ] Step 1: Add adapter facade over existing runtime definitions
  - [ ] Substep 1.1 Implement: add minimal public `RuntimeAdapter`, spawn, attachment, sink, and close-decision types required by upper-layer dispatch removal.
  - [ ] Substep 1.2 Implement: add `getRuntimeAdapter(agentId)` by composing existing `RuntimeAgentDef` entries, parser helpers, and session helpers; keep `defs/*` in place.
  - [ ] Substep 1.3 Implement: add normalized sink helpers only where needed for shared chat/connection-test attach behavior, without changing existing SSE channel names.
  - [ ] Substep 1.4 Verify: unit-test adapter lookup coverage, unknown agent failure, and sink channel mapping.
- [ ] Step 2: Move stream/session attachment behind adapters
  - [ ] Substep 2.1 Implement: migrate Claude/Qoder/Copilot/JSON-event/plain attachment logic into adapters.
  - [ ] Substep 2.2 Implement: migrate Pi/ACP session attachment and runtime session handles into adapters.
  - [ ] Substep 2.3 Implement: update `connectionTest.ts` to consume shared adapters first.
  - [ ] Substep 2.4 Verify: run daemon parser/session tests plus new fake-child adapter tests.
- [ ] Step 3: Refactor chat orchestration to adapter boundary calls
  - [ ] Substep 3.1 Implement: replace `server.ts` `getAgentDef`, args building, stdin handling, and stream-format dispatch with `getRuntimeAdapter`, `runtime.spawn`, `runtime.attach`, `runtime.deliverPrompt`, and `runtime.evaluateClose` calls.
  - [ ] Substep 3.2 Implement: move stdin mode, prompt delivery, env/args, and close decisions into adapter methods; move external MCP preparation, image support, or prompt budget only if required to remove upper-layer dispatch.
  - [ ] Substep 3.3 Implement: preserve existing `run.acpSession` storage; introduce generic runtime session naming only if the adapter boundary cannot otherwise represent session-aware runtimes.
  - [ ] Substep 3.4 Verify: run daemon tests and add regression coverage for empty-output, structured error, and ACP clean SIGTERM behavior.
- [ ] Step 4: Remove upper-layer format knowledge
  - [ ] Substep 4.1 Implement: replace prompt mode and Critique Theater format checks with adapter capabilities only where those checks are currently in upper-layer dispatch paths.
  - [ ] Substep 4.2 Implement: add guard/regression check preventing `getAgentDef`, direct runtime launch/protocol field access, or runtime format dispatch in `server.ts` and `connectionTest.ts`.
  - [ ] Substep 4.3 Verify: run `pnpm --filter @open-design/daemon test`, `pnpm --filter @open-design/daemon typecheck`, `pnpm guard`, and `pnpm typecheck`.

## Notes

<!-- Optional sections — add what's relevant. -->

### Implementation

<!-- Files created/modified, decisions made during coding, deviations from design -->

### Verification

<!-- How the feature was verified: tests written, manual testing steps, results -->
