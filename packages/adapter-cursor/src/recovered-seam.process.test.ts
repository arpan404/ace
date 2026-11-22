import * as sdk from "@cursor/sdk";
import type { LocalAgentStore } from "@cursor/sdk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import {
  HostRuntime,
  CursorTranslator,
  CursorLimitsSchema,
  unbatch,
  recoverCursorCheckpoint,
  type CursorEnvelope,
  type RuntimeSdkBoundary,
} from "./index.ts";
import { UnsettledRuns } from "./unsettled.ts";

// A real process edge: the SDK's own SQLite store, written by a fake SDK in the order SDK 1.0.35
// writes it, read back by the real recovery after a cut at every committed frame.

/** The updates one Cursor turn streams: text, thinking, a shell with live output, more text. */
const updates = [
  { type: "text-delta", text: "Let me " },
  { type: "text-delta", text: "check." },
  { type: "thinking-delta", text: "the tests " },
  { type: "thinking-delta", text: "first" },
  { type: "thinking-completed", thinkingDurationMs: 5 },
  { type: "tool-call-started", callId: "sh", toolCall: { type: "shell", args: { command: "ls" } } },
  { type: "shell-output-delta", callId: "sh", text: "a.ts\n" },
  {
    type: "tool-call-completed",
    callId: "sh",
    toolCall: {
      type: "shell",
      args: { command: "ls" },
      result: {
        status: "success",
        value: { exitCode: 0, stdout: "a.ts\n", stderr: "", signal: "", executionTime: 1 },
      },
    },
  },
  { type: "text-delta", text: "All " },
  // Two identical updates in a row: each must show exactly once.
  { type: "text-delta", text: "good " },
  { type: "text-delta", text: "good " },
  { type: "text-delta", text: "here." },
];

/** What SDK 1.0.35 stores for an update, as its own mapping does (none for shell output). */
function stored(update: Record<string, unknown>, runId: string): unknown {
  const base = { agent_id: "agent", run_id: runId };
  switch (update.type) {
    case "text-delta":
      return {
        type: "assistant",
        ...base,
        message: { role: "assistant", content: [{ type: "text", text: update.text }] },
      };
    case "thinking-delta":
      return { type: "thinking", ...base, text: update.text };
    case "thinking-completed":
      return {
        type: "thinking",
        ...base,
        text: "",
        thinking_duration_ms: update.thinkingDurationMs,
      };
    case "tool-call-started":
    case "tool-call-completed": {
      const call = update.toolCall as Record<string, unknown>;
      return {
        type: "tool_call",
        ...base,
        call_id: update.callId,
        name: call.type,
        status: update.type === "tool-call-started" ? "running" : "completed",
        args: call.args,
        ...("result" in call ? { result: call.result } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Whether the fake SDK calls onDelta before it stores the update's event (1.0.35), or after. */
type Order = "callback-first" | "write-first";

/** A fake SDK whose runs write the store as SDK 1.0.35 does, in either order per update. */
function fakeSdk(order: Order): RuntimeSdkBoundary {
  let store: LocalAgentStore | undefined;
  const append = (runId: string, message: unknown) =>
    store!.runEvents.append({
      runId,
      eventType: "run_stream_event",
      payload: { schemaVersion: 1, type: "sdk_message", agentId: "agent", runId, message },
    });
  const agent = {
    agentId: "agent",
    async [Symbol.asyncDispose]() {},
    async send(
      _input: unknown,
      options?: { onDelta?: (event: { update: unknown }) => Promise<void> },
    ) {
      const runId = "run-1";
      const now = Date.now();
      await store!.runs.create({
        run: {
          runId,
          agentId: "agent",
          turnNumber: 1,
          status: "running",
          createdAt: now,
          updatedAt: now,
        },
      });
      // As the SDK does: the agent points at its new run, stamped with its creation.
      const agentRecord = await store!.agents.get({ agentId: "agent" });
      if (agentRecord)
        await store!.agents.update({
          agent: { ...agentRecord, activeRunId: runId, updatedAt: now },
        });
      const done = (async () => {
        // Stored but never streamed live, then the run's status.
        await append(runId, { type: "request", agent_id: "agent", run_id: runId, request_id: "r" });
        await append(runId, {
          type: "status",
          agent_id: "agent",
          run_id: runId,
          status: "RUNNING",
        });
        for (const update of updates) {
          const message = stored(update, runId);
          if (order === "write-first" && message) await append(runId, message);
          await options?.onDelta?.({ update });
          if (order === "callback-first" && message) await append(runId, message);
        }
        const run = await store!.runs.get({ agentId: "agent", runId });
        if (run)
          await store!.runs.update({ run: { ...run, status: "finished", result: "All good." } });
        const ended = await store!.agents.get({ agentId: "agent" });
        if (ended)
          await store!.agents.update({
            agent: { ...ended, activeRunId: null, updatedAt: Date.now() },
          });
      })();
      return {
        id: runId,
        async *stream() {
          await done;
          yield* [];
        },
        async wait() {
          await done;
          return { id: runId, status: "finished" as const };
        },
        async cancel() {},
      };
    },
  };
  const boundary = {
    ...sdk,
    Cursor: { auth: { status: async () => ({ status: "logged-in" }) } },
    Agent: {
      async create(options: { local: { store: LocalAgentStore; cwd: string } }) {
        store = options.local.store;
        const blobId = "ab".repeat(32);
        await store.checkpoints.create({ agentId: "agent", blobId, data: new Uint8Array([1]) });
        await store.agents.create({
          agent: {
            agentId: "agent",
            cwd: options.local.cwd,
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
            latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId },
          } as never,
        });
        return agent;
      },
      async resume(_id: string, options: { local: { store: LocalAgentStore } }) {
        store = options.local.store;
        return agent;
      },
      cancelRun: async () => {},
    },
  } as unknown as RuntimeSdkBoundary;
  return boundary;
}

/** The transcript a translator shows for `frames`: messages, reasoning and tool calls. */
function shown(frames: CursorEnvelope[]) {
  const threadId = ThreadId.parse("seam");
  const translator = new CursorTranslator({ threadId, rootKey: "root" });
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
  let id = 0;
  frames.forEach((data, index) => {
    for (const fact of translator.translate(
      {
        seq: index + 1,
        t: index + 1,
        dir: data.kind === "send" ? "send" : "recv",
        channel: "sdk",
        data,
      },
      index + 1,
    ))
      apply(state, fact, { now: index + 1, ids: { next: (kind) => `${kind}-${++id}` } });
  });
  return Object.values(state.items).flatMap((item) => {
    if (item.type === "message")
      return [`${item.role}: ${item.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}`];
    if (item.type === "reasoning") return [`thinking: ${item.text}`];
    if (item.type === "tool_call")
      return [
        `tool ${item.call.kind} ${item.call.status} ${JSON.stringify("output" in item.call.detail ? item.call.detail.output : null)}`,
      ];
    return [];
  });
}

const limits = CursorLimitsSchema.parse({});
/** A host process's run of `open`, as the daemon sees it: the frames it stored, in order. */
async function host(
  boundary: RuntimeSdkBoundary,
  home: string,
  generation: string,
  run: (host: HostRuntime, stored: () => CursorEnvelope[]) => Promise<void>,
): Promise<CursorEnvelope[]> {
  const frames: CursorEnvelope[] = [];
  const runtime = new HostRuntime(
    boundary,
    async (frame) => {
      frames.push(...unbatch(frame));
    },
    () => home,
    {},
  );
  await run(runtime, () => frames);
  await runtime.close();
  return frames.filter((frame) => frame.kind !== "close");
}
/** A daemon start after a crash: its host reopens with what `record` lacks of the open turn. */
function reopen(boundary: RuntimeSdkBoundary, home: string, record: CursorEnvelope[], n: number) {
  const fold = new UnsettledRuns();
  for (const frame of record) fold.add(frame);
  return host(boundary, home, `reopen-${n}`, async (runtime) => {
    await runtime.open({
      threadId: "seam",
      cwd: home,
      generation: `reopen-${n}`,
      nativeSessionId: "agent",
      recover: fold.result(),
      policy: "full-access",
      limits,
    });
  });
}

it.each(["callback-first", "write-first"] as const)(
  "a recovered tail is exact at every crash point, %s, and through a second crash mid-recovery",
  async (order) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-seam-")));
    try {
      const boundary = fakeSdk(order);
      let reopened = 0;
      const frames = await host(boundary, home, "live", async (runtime, stored) => {
        await runtime.open({
          threadId: "seam",
          cwd: home,
          generation: "live",
          policy: "full-access",
          limits,
        });
        await runtime.send({
          operationId: "op",
          commandId: "op",
          segment: 0,
          input: [{ type: "text", text: "go" }],
        });
        await expect.poll(() => stored().some((frame) => frame.kind === "result")).toBe(true);
      });
      const whole = shown(frames);
      expect(whole).toContain("assistant: Let me check.");
      expect(whole).toContain("assistant: All good good here.");
      const live = frames.filter((frame) => frame.kind !== "result");
      const first = live.findIndex((frame) => frame.kind === "send") + 1;
      for (let cut = first; cut <= live.length; cut++) {
        const committed = live.slice(0, cut);
        const recovery = await reopen(boundary, home, committed, ++reopened);
        expect({ cut, shown: shown([...committed, ...recovery]) }).toEqual({ cut, shown: whole });
        // The reopen dies after storing only some of what it read back; the next one goes on.
        for (let kept = 1; kept < recovery.length; kept++) {
          const partial = [...committed, ...recovery.slice(0, kept)];
          const again = await reopen(boundary, home, partial, ++reopened);
          expect({ cut, kept, shown: shown([...partial, ...again]) }).toEqual({
            cut,
            kept,
            shown: whole,
          });
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
