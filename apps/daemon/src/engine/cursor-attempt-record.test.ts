import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { Command, type ThreadId } from "@ace/protocol";
import { ProviderRecovery } from "./provider-recovery.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** A Cursor thread in a real store, with no provider frames at all. */
async function thread(): Promise<{ store: Store; id: ThreadId }> {
  const root = await mkdtemp(join(tmpdir(), "cursor-attempt-record-"));
  const store = new Store(join(root, "events.sqlite"));
  const registry = new AdapterRegistry();
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession() {
        throw new Error("no session in this test");
      },
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  const engine = new Engine(store, { registry });
  cleanup.push(async () => {
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = engine.handler.handle(
    Command.parse({
      id: "create",
      deviceId: "device",
      payload: {
        type: "thread.create",
        provider: "cursor",
        workspaceId: store.createWorkspace(root, "Fixture"),
        input: [{ type: "text", text: "hi" }],
      },
    }),
    store,
  );
  if (!result.threadId) throw new Error("Missing thread");
  await engine.flush();
  store.statement("DELETE FROM engine_provider_frames").run();
  return { store, id: result.threadId };
}
const frame = (kind: string, body: unknown, operationId = "send-1") => ({
  schemaVersion: 1,
  generation: "host",
  operationId,
  commandId: "send-1",
  segment: 0,
  kind,
  body,
});

test("whether Cursor had an attempted send is read from its record, not by searching the thread's frames", async () => {
  const { store, id } = await thread();
  const recovery = new ProviderRecovery(store);
  expect(recovery.attempted(id, "send-1")).toBe(false);
  recovery.note(id, frame("send", { input: [], attemptedAt: 1, runFramed: true }));
  recovery.note(id, frame("run", { nativeRunId: "run-1" }));
  // Nothing of the send but its attempt and its run's id: no sign yet Cursor had it.
  expect(recovery.attempted(id, "send-1")).toBe(true);
  expect(recovery.admissionRecorded(id, "send-1")).toBe(false);
  expect(recovery.lastAdmission(id)).toBeUndefined();
  recovery.note(id, frame("admission", { commandId: "send-1", admitted: false }, "open"));
  expect(recovery.lastAdmission(id)).toEqual({ commandId: "send-1", admitted: false });
  recovery.note(id, frame("delta", { type: "text-delta", text: "hello" }));
  expect(recovery.admissionRecorded(id, "send-1")).toBe(true);
  // The thread's frames hold none of this: every answer came from the record.
  expect(store.statement("SELECT COUNT(*) AS n FROM engine_provider_frames").get()?.n).toBe(0);
});

test("a fresh session forgets the previous session's attempt", async () => {
  const { store, id } = await thread();
  const recovery = new ProviderRecovery(store);
  recovery.note(id, frame("send", { input: [], attemptedAt: 1, runFramed: true }));
  recovery.reset(id);
  expect(recovery.attempted(id, "send-1")).toBe(false);
});

/** Stores a Cursor frame of `kind` for `id` as the actor does; its row. */
function store(h: { store: Store; id: ThreadId }, seq: number, kind: string, operationId = "old") {
  const result = h.store
    .statement("INSERT INTO engine_provider_frames VALUES (?,?,?,?)")
    .run(
      h.id,
      "host",
      seq,
      JSON.stringify({
        seq,
        t: seq,
        dir: "recv",
        channel: "sdk",
        data: frame(kind, {}, operationId),
      }),
    );
  return Number(result.lastInsertRowid);
}
const count = (h: { store: Store }) =>
  Number(h.store.statement("SELECT COUNT(*) AS n FROM engine_provider_frames").get()?.n);

test("a new turn on a long Cursor thread drops the settled turns' frames a bounded batch per commit", async () => {
  const h = await thread();
  const recovery = new ProviderRecovery(h.store);
  recovery.captured(h.id, "open", store(h, 1, "open"), false);
  for (let seq = 2; seq < 1002; seq++) store(h, seq, "delta");
  recovery.captured(h.id, "send", store(h, 1002, "send", "new"), true);
  recovery.trimStep(h.id);
  // One step deletes a bounded batch, not the thousand frames behind the new turn.
  expect(count(h)).toBe(1002 - 256);
  for (let step = 0; step < 10; step++) recovery.trimStep(h.id);
  // In the end: the session's open frame and the new turn's send.
  expect(count(h)).toBe(2);
});

test("a restart in the middle of that clean-up reads only the open frame and the new turn", async () => {
  const h = await thread();
  const recovery = new ProviderRecovery(h.store);
  recovery.captured(h.id, "open", store(h, 1, "open"), false);
  for (let seq = 2; seq < 600; seq++) store(h, seq, "delta");
  recovery.captured(h.id, "send", store(h, 600, "send", "new"), true);
  recovery.trimStep(h.id);
  const seen: string[] = [];
  await recovery.restore(h.id, {
    translate(input) {
      seen.push(String((input.data as { kind?: string }).kind));
      return [];
    },
    tick: () => [],
  });
  expect(seen).toEqual(["open", "send"]);
});
