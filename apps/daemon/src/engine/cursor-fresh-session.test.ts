import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { Command, type CommandPayload, type ThreadId } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { sessionStoreUnusable } from "@ace/provider-kit/open-error";
import { receivedHandoff } from "./transition-test-support.ts";

/*
 * A Cursor thread whose saved SDK session can no longer be used continues in a fresh Cursor
 * session that gets the thread's context from ace's own transcript (ADR 0211). The fake below
 * speaks the SDK host's frames through the real Cursor translator; nothing reaches Cursor.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

const fenceMessage =
  "ace could not write Cursor's checkpoint: SDK checkpoint growth exceeds budget; previous checkpoint retained. Execution is fenced; preserve this thread and use explicit bounded context handoff.";

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "cursor-fresh-session-"));
  const store = new Store(join(root, "events.sqlite"));
  const registry = new AdapterRegistry();
  const opens: { resume?: string; generation?: number }[] = [];
  const sends: { agent: string; text: string }[] = [];
  /** Agents whose saved session the SDK can no longer open. */
  const broken = new Set<string>();
  const state = {
    agents: 0,
    failFresh: 0,
    failResume: 0,
    fenceNext: false,
    hold: false,
    answer: (n: number) => `answer ${n}`,
  };
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession(context: SessionContext) {
        const resume = context.resume?.nativeSessionId;
        opens.push({
          ...(resume ? { resume } : {}),
          ...(context.storeGeneration ? { generation: context.storeGeneration } : {}),
        });
        if (resume && broken.has(resume))
          throw Object.assign(
            new Error(
              "SDK boundary failed: SDK journal is fenced or uninitialized. Cursor SDK open failed; delivery may be uncertain.",
            ),
            { code: sessionStoreUnusable },
          );
        if (resume && state.failResume > 0) {
          state.failResume--;
          throw new Error("Cursor SDK open failed: network unreachable");
        }
        if (!resume && state.failFresh > 0) {
          state.failFresh--;
          throw new Error("Temporary Cursor start failure");
        }
        const agent = resume ?? `agent-${++state.agents}`;
        context.signal.addEventListener("abort", () => context.onExit({ deliberate: false }), {
          once: true,
        });
        context.onSessionIdentity?.({
          backend: "cursor-sdk",
          instanceId: "fixture",
          nativeSessionId: agent,
        });
        let offset = context.resume?.afterFrameOffset ?? 0;
        let operationId = "open";
        const emit = async (kind: string, body: unknown) => {
          const seq = ++offset;
          const payload = new ProviderPayload(
            JSON.stringify({
              schemaVersion: 1,
              generation: `host-${agent}`,
              operationId,
              segment: 0,
              agentId: agent,
              kind,
              body,
              boundaryOffset: seq,
            }),
          );
          await context.onFrame({
            seq: seq * 1024,
            t: seq,
            dir: "recv",
            channel: "sdk",
            data: payload.data,
            payload,
          });
        };
        await emit("open", { cwd: root });
        return {
          nativeSessionId: agent,
          backend: "cursor-sdk",
          instanceId: "fixture",
          async send(input, _delivery, intent) {
            const text = input.map((part) => (part.type === "text" ? part.text : "")).join("\n");
            sends.push({ agent, text });
            operationId = intent ?? `send-${sends.length}`;
            await emit("send", { input });
            await emit("delta", { type: "text-delta", text: state.answer(sends.length) });
            // Still working when the daemon stops: no result frame.
            if (state.hold) return;
            if (state.fenceNext) {
              state.fenceNext = false;
              broken.add(agent);
              await emit("error", { code: "checkpoint_budget", message: fenceMessage });
              return;
            }
            await emit("result", { status: "finished" });
          },
          async interrupt() {},
          async resolve() {},
          async stopTask() {},
          async close() {},
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  let engine = new Engine(store, { registry });
  let serial = 0;
  const workspaceId = store.createWorkspace(root, "Fixture");
  const command = (payload: CommandPayload) =>
    engine.handler.handle(
      Command.parse({ id: `command-${++serial}`, deviceId: "fixture", payload }),
      store,
    );
  cleanup.push(async () => {
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    opens,
    sends,
    broken,
    state,
    get engine() {
      return engine;
    },
    async create(text: string): Promise<ThreadId> {
      const result = command({
        type: "thread.create",
        workspaceId,
        provider: "cursor",
        input: [{ type: "text", text }],
      });
      if (!result.threadId) throw new Error("Missing thread");
      await engine.flush();
      return result.threadId;
    },
    async send(threadId: ThreadId, text: string) {
      expect(
        command({
          type: "thread.send",
          threadId,
          delivery: "queue",
          input: [{ type: "text", text }],
        }),
      ).toMatchObject({ ok: true });
      await engine.flush();
    },
    async retry(threadId: ThreadId) {
      command({
        type: "queue.resume",
        threadId,
        expectedRevision: engine.queue(threadId).revision,
      });
      await engine.flush();
    },
    async resume(threadId: ThreadId) {
      command({
        type: "thread.resume",
        threadId,
        expectedRevision: engine.queue(threadId).revision,
      });
      await engine.flush();
    },
    async restart() {
      await engine.close();
      engine = new Engine(store, { registry });
      await engine.ready();
    },
    /** What the transcript shows, as the one-line texts of ace's quiet rows and the messages. */
    transcript(threadId: ThreadId) {
      const snapshot = store.snapshotThread(threadId);
      return snapshot.itemOrder.map((id) => snapshot.items[id]);
    },
  };
}

const sentTexts = (sends: { agent: string; text: string }[], text: string) =>
  sends.filter((send) => send.text.endsWith(text));

test("a thread fenced by the checkpoint budget continues its queued message in a fresh Cursor session", async () => {
  const h = await harness();
  h.state.fenceNext = true;
  const id = await h.create("build the parser");
  await h.send(id, "now add the tests");

  // The fenced session is never resumed: the message goes to a new agent with the context.
  expect(h.opens).toEqual([{}, { generation: 1 }]);
  const delivered = sentTexts(h.sends, "now add the tests");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.agent).toBe("agent-2");
  const handoff = receivedHandoff(delivered[0]?.text ?? "");
  expect(handoff.block).toContain("build the parser");
  expect(handoff.sourceThreadId).toBe(id);
  expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, lastFailure: null });
  expect(h.store.getThread(id)?.status.state).toBe("done");
  // The person sees one quiet line saying what happened, not an error.
  const rows = h.transcript(id);
  const fresh = rows.filter(
    (item) =>
      item?.type === "message" && item.origin?.kind === "handoff" && item.origin.freshSession,
  );
  expect(fresh).toHaveLength(1);
});

test("a saved session the SDK can no longer open hands off once and the agent hears it is resuming", async () => {
  const h = await harness();
  const id = await h.create("draft the release notes");
  h.broken.add("agent-1");
  await h.restart();
  await h.send(id, "add the changelog link");

  expect(h.opens).toEqual([{}, { resume: "agent-1" }, { generation: 1 }]);
  const delivered = sentTexts(h.sends, "add the changelog link");
  expect(delivered.map((send) => send.agent)).toEqual(["agent-2"]);
  expect(delivered[0]?.text).toContain("fresh Cursor session");
  expect(receivedHandoff(delivered[0]?.text ?? "").block).toContain("draft the release notes");
  expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, lastFailure: null });

  // The fresh session is the thread's own from now on: after a restart it resumes, plainly.
  await h.restart();
  await h.send(id, "thanks");
  expect(h.opens.at(-1)).toEqual({ resume: "agent-2", generation: 1 });
  expect(sentTexts(h.sends, "thanks")[0]?.text).toBe("thanks");
});

test("the queued message is sent once when the daemon restarts mid-handoff", async () => {
  const h = await harness();
  const id = await h.create("rename the module");
  h.broken.add("agent-1");
  h.state.failFresh = 1;
  await h.restart();
  await h.send(id, "and update the imports");

  // The handoff is committed; the fresh start failed for an unrelated reason and is held.
  expect(h.engine.queue(id)).toMatchObject({ paused: true, pendingCount: 1 });
  expect(sentTexts(h.sends, "and update the imports")).toHaveLength(0);

  await h.restart();
  await h.retry(id);

  // Still the first fresh generation: the restart neither repeats the handoff nor the message.
  expect(h.opens.at(-1)).toEqual({ generation: 1 });
  const delivered = sentTexts(h.sends, "and update the imports");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.text.split("<ace_context_handoff ").length).toBe(2);
  const rows = h.transcript(id);
  expect(rows.filter((item) => item?.type === "message" && item.origin?.freshSession)).toHaveLength(
    1,
  );
  expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, lastFailure: null });
});

test("handoff context stays under its cap for a very long thread", async () => {
  const h = await harness();
  h.state.answer = (n) => `answer ${n} ${"detail ".repeat(700)}`;
  const id = await h.create("opening ask: port the scheduler");
  for (let turn = 0; turn < 40; turn++) await h.send(id, `step ${turn}`);
  h.broken.add("agent-1");
  await h.restart();
  await h.send(id, "finish it");

  const delivered = sentTexts(h.sends, "finish it");
  expect(delivered.map((send) => send.agent)).toEqual(["agent-2"]);
  const handoff = receivedHandoff(delivered[0]?.text ?? "");
  expect(handoff.bytes).toBeLessThanOrEqual(32768);
  // The opening ask and the latest exchange survive; older items stay one handoff_read away.
  expect(handoff.block).toContain("opening ask: port the scheduler");
  expect(handoff.block).toContain("step 39");
  expect(handoff.read?.sourceThreadId).toBe(id);
});

test("a temporary failure to resume keeps the saved Cursor session", async () => {
  const h = await harness();
  const id = await h.create("check the build");
  h.state.failResume = 1;
  await h.restart();
  await h.send(id, "again");
  expect(h.engine.queue(id)).toMatchObject({ paused: true, pendingCount: 1 });
  await h.retry(id);
  expect(h.opens).toEqual([{}, { resume: "agent-1" }, { resume: "agent-1" }]);
  expect(sentTexts(h.sends, "again").map((send) => send.text)).toEqual(["again"]);
});

test("a turn a restart cut short continues in a fresh session when its saved one can't open", async () => {
  const h = await harness();
  h.state.hold = true;
  const id = await h.create("migrate the database");
  h.state.hold = false;
  h.broken.add("agent-1");
  await h.restart();
  await h.engine.flush();
  // The person's Resume (or ace's own, after a restart) takes the handoff path, not a dead end.
  await h.resume(id);

  expect(h.opens).toEqual([{}, { resume: "agent-1" }, { generation: 1 }]);
  const continued = h.sends.filter((send) => send.agent === "agent-2");
  expect(continued).toHaveLength(1);
  expect(receivedHandoff(continued[0]?.text ?? "").block).toContain("migrate the database");
  expect(h.store.getThread(id)?.status.state).toBe("done");
});
