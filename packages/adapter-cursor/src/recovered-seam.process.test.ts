import * as sdk from "@cursor/sdk";
import type { LocalAgentStore } from "@cursor/sdk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { apply, createThreadState, deriveThreadStatus } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import {
  HostRuntime,
  CursorTranslator,
  CursorLimitsSchema,
  unbatch,
  type CursorEnvelope,
  type RuntimeSdkBoundary,
} from "./index.ts";
import { UnsettledRuns } from "./unsettled.ts";
import { updateIdentity } from "./event-identity.ts";
import { createHash } from "node:crypto";

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
      // The SDK shortened this result; it stores the update as it carried it (1.0.35).
      truncated: { result: true },
      result: {
        status: "success",
        value: { exitCode: 0, stdout: "a.ts\n", stderr: "", signal: "", executionTime: 1 },
      },
    },
  },
  // A second call whose arguments stream in as two different partials: the last is all of it
  // the turn ever shows, so losing it shows.
  { type: "partial-tool-call", callId: "rd", toolCall: { type: "read", args: { path: "a" } } },
  { type: "partial-tool-call", callId: "rd", toolCall: { type: "read", args: { path: "a.ts" } } },
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
    case "partial-tool-call":
    case "tool-call-completed": {
      const call = update.toolCall as Record<string, unknown>;
      return {
        type: "tool_call",
        ...base,
        call_id: update.callId,
        name: call.type,
        status: update.type === "tool-call-completed" ? "completed" : "running",
        args: call.args,
        ...("result" in call ? { result: call.result } : {}),
        ...(call.truncated ? { truncated: call.truncated } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Whether the fake SDK calls onDelta before it stores the update's event (1.0.35), or after. */
type Order = "callback-first" | "write-first";

/** A fake SDK whose runs write the store as SDK 1.0.35 does, in either order per update. */
function fakeSdk(
  order: Order,
  dropAppend?: number,
  run: { updates: Record<string, unknown>[]; result: string; lostFrom?: number } = {
    updates,
    result: "All good good here.",
  },
): RuntimeSdkBoundary {
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
        for (const [index, update] of run.updates.entries()) {
          // The SDK swallows a failed write: that update's event is simply never stored.
          const lost =
            index === dropAppend || (run.lostFrom !== undefined && index >= run.lostFrom);
          const message = lost ? undefined : stored(update, runId);
          if (order === "write-first" && message) await append(runId, message);
          await options?.onDelta?.({ update });
          if (order === "callback-first" && message) await append(runId, message);
        }
        const record = await store!.runs.get({ agentId: "agent", runId });
        if (record)
          await store!.runs.update({
            run: { ...record, status: "finished", result: run.result },
          });
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
  return transcript(frames).shown;
}
function transcript(frames: CursorEnvelope[]) {
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
  const notices = Object.values(state.items).flatMap((item) =>
    item.type === "notice" ? [item.text ?? ""] : [],
  );
  const shownItems = Object.values(state.items).flatMap((item) => {
    if (item.type === "message")
      return [`${item.role}: ${item.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}`];
    if (item.type === "reasoning") return [`thinking: ${item.text}`];
    if (item.type === "tool_call")
      return [`tool ${item.call.kind} ${item.call.status} ${JSON.stringify(item.call.detail)}`];
    return [];
  });
  return { shown: shownItems, notices, status: deriveThreadStatus(state).state };
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

/** The index of a text update in the middle of the run whose stored event the SDK loses. */
const lostAppend = updates.findIndex(
  (update) => update.type === "text-delta" && update.text === "good ",
);
/** The first of a call's partials, whose stored event the SDK loses; a different one follows. */
const lostPartial = updates.findIndex((update) => update.type === "partial-tool-call");

it.each([
  ["callback-first", undefined],
  ["write-first", undefined],
  ["callback-first", lostAppend],
  ["write-first", lostAppend],
  ["callback-first", lostPartial],
  ["write-first", lostPartial],
] as const)(
  "a recovered tail is exact at every crash point, %s (lost write at %s), and through a second crash mid-recovery",
  async (order, drop) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-seam-")));
    try {
      const boundary = fakeSdk(order, drop);
      let reopened = 0;
      const frames = await host(boundary, home, "live", async (runtime, published) => {
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
        await expect.poll(() => published().some((frame) => frame.kind === "result")).toBe(true);
      });
      const whole = shown(frames);
      expect(whole).toContain("assistant: Let me check.");
      expect(whole).toContain("assistant: All good good here.");
      const live = frames.filter((frame) => frame.kind !== "result");
      // The SDK creates the run only once ace has stored its id (the `run` frame); a crash
      // before that leaves no run, which the attempt tests cover. Cuts start after it.
      const first = live.findIndex((frame) => frame.kind === "run") + 1;
      expect(first).toBeGreaterThan(0);
      // The update whose write the SDK lost exists only in ace's frames: a crash before ace
      // committed it leaves it nowhere, so only those cuts miss it, and only it.
      // A lost partial is overtaken by the call's next state, so no cut misses anything.
      const lostFrame =
        drop !== lostAppend
          ? -1
          : live.findIndex((frame) => JSON.stringify(frame.body).includes("good "));
      // Those cuts miss it as the answer streamed, and then show the whole answer from Cursor's
      // saved result: the turn never ends on a fragment.
      const expected = (cut: number) =>
        drop === lostAppend && cut <= lostFrame
          ? [
              ...whole.map((line) => line.replace("All good good here.", "All good here.")),
              "assistant: All good good here.",
            ]
          : whole;
      for (let cut = first; cut <= live.length; cut++) {
        const committed = live.slice(0, cut);
        const recovery = await reopen(boundary, home, committed, ++reopened);
        expect({ cut, shown: shown([...committed, ...recovery]) }).toEqual({
          cut,
          shown: expected(cut),
        });
        // The reopen dies after storing only some of what it read back; the next one goes on.
        for (let kept = 1; kept < recovery.length; kept++) {
          const partial = [...committed, ...recovery.slice(0, kept)];
          const again = await reopen(boundary, home, partial, ++reopened);
          expect({ cut, kept, shown: shown([...partial, ...again]) }).toEqual({
            cut,
            kept,
            shown: expected(cut),
          });
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

it("a turn an earlier ace build was running shows nothing twice once the new build reopens it", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-seam-legacy-")));
  try {
    const boundary = fakeSdk("callback-first");
    const frames = await host(boundary, home, "live", async (runtime, published) => {
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
      await expect.poll(() => published().some((frame) => frame.kind === "result")).toBe(true);
    });
    // What an earlier build stored: the same frames, with nothing about the SDK's events.
    const old = frames
      .filter((frame) => frame.kind !== "result")
      .map(({ eventSeq: _seq, pendingEvents: _pending, ...frame }) => frame);
    const cut = old.findIndex(
      (frame) => frame.kind === "delta" && JSON.stringify(frame.body).includes("thinking-delta"),
    );
    const committed = old.slice(0, cut);
    const before = shown(committed);
    expect(before).toContain("assistant: Let me check.");
    const after = transcript([...committed, ...(await reopen(boundary, home, committed, 1))]);
    // Nothing replayed: only the turn's final answer, from Cursor's saved result.
    expect(after.shown).toEqual([...before, "assistant: All good good here."]);
    expect(
      after.notices.filter((text) => text.includes("began before ace was updated")),
    ).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const field = (value: unknown, cut?: number) => JSON.stringify(value ?? null).slice(0, cut);
/** The stamp an earlier build of this branch gave a tool update: `exact:fingerprint`. */
function earlierStamp(update: Record<string, unknown>): string {
  const call = update.toolCall as { args?: unknown; result?: unknown };
  const phase = update.type === "tool-call-completed" ? "ended" : "running";
  const key = (cut?: number) =>
    `tool_call\0${String(update.callId)}\0${phase}\0${field(call.args, cut)}\0${field(call.result, cut)}`;
  return `${digest(key())}:${digest(key(256))}`;
}

it("a tool update an earlier build committed but whose stored write it never saw is not shown twice", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-seam-upgrade-")));
  try {
    // Callback first: ace commits each update before the SDK stores its event.
    const boundary = fakeSdk("callback-first");
    const frames = await host(boundary, home, "live", async (runtime, published) => {
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
      await expect.poll(() => published().some((frame) => frame.kind === "result")).toBe(true);
    });
    // The same frames as an earlier build stamped them: its tool updates' identities differ.
    const earlier = new Map(
      updates
        .filter((update) => String(update.type).includes("tool-call"))
        .map((update) => [updateIdentity(update) ?? "", earlierStamp(update)]),
    );
    const old = frames.filter((frame) => frame.kind !== "result");
    for (const frame of old)
      if (frame.pendingEvents)
        frame.pendingEvents = frame.pendingEvents.map((id) => earlier.get(id) ?? id);
    // The daemon died right after committing the first partial, before its stored event's offset.
    const cut =
      old.findIndex((frame) => JSON.stringify(frame.body).includes("partial-tool-call")) + 1;
    expect(cut).toBeGreaterThan(0);
    const committed = old.slice(0, cut);
    const recovered = await reopen(boundary, home, committed, 1);
    // The partial ace committed is not read back again; what came after it is.
    const replayed = recovered.filter(
      (frame) => frame.kind === "recovered" && JSON.stringify(frame.body).includes('{"path":"a"}'),
    );
    expect(replayed).toEqual([]);
    const after = transcript([...committed, ...recovered]);
    // As the turn shows had nothing crashed.
    const whole = transcript(frames);
    expect(after.shown).toEqual(whole.shown);
    expect(after.status).toBe(whole.status);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** A finished turn whose answer the SDK saved but whose later writes it lost, read back. */
async function recoverSavedAnswer(rest: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-seam-long-")));
  try {
    // The answer streams in two parts; ace has the first, and the SDK lost every later write.
    const answer = `Start: ${rest}`;
    const boundary = fakeSdk("callback-first", undefined, {
      updates: [
        { type: "text-delta", text: "Start: " },
        { type: "text-delta", text: rest },
      ],
      result: answer,
      lostFrom: 1,
    });
    const frames = await host(boundary, home, "live", async (runtime, published) => {
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
      await expect.poll(() => published().some((frame) => frame.kind === "result")).toBe(true);
    });
    const live = frames.filter((frame) => frame.kind !== "result");
    // The daemon died once it had the first part.
    const cut = live.findIndex((frame) => JSON.stringify(frame.body).includes("Start: ")) + 1;
    const committed = live.slice(0, cut);
    const back = await reopen(boundary, home, committed, 1);
    const after = transcript([...committed, ...back]);
    const answers = after.shown.filter((line) => line.startsWith("assistant: "));
    return { ...after, answer, last: answers.at(-1)?.slice("assistant: ".length) };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

it("a finished turn's long saved answer comes back whole, past the frame preview", async () => {
  const after = await recoverSavedAnswer("y".repeat(80 * 1024));
  expect(after.last).toBe(after.answer);
  expect(after.status).toBe("done");
});

it("a finished turn's 2 MiB saved answer in multibyte text comes back whole", async () => {
  // Over 1 Mi characters and 2 MiB of UTF-8, in two- and four-byte characters.
  const after = await recoverSavedAnswer(`${"é".repeat(900_000)}${"🌊".repeat(200_000)}`);
  expect(after.last).toBe(after.answer);
  expect(after.notices.some((text) => text.includes("cut after"))).toBe(false);
  expect(after.status).toBe("done");
});

it("a saved answer past 4 MiB of UTF-8 is shown cut at 4 MiB, with a note saying so", async () => {
  // 3 Mi characters, 6 MiB of UTF-8: under a cap counted in characters it would all show.
  const after = await recoverSavedAnswer("é".repeat(3 * 1024 * 1024));
  const bytes = new TextEncoder().encode(after.last ?? "").length;
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(bytes).toBeGreaterThan(4 * 1024 * 1024 - 8);
  expect(after.answer.startsWith(after.last ?? "missing")).toBe(true);
  expect(after.notices.some((text) => text.includes("cut after the first 4 MiB"))).toBe(true);
  expect(after.status).toBe("done");
});
