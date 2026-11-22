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

/** Stores a Cursor frame of `kind` for `id` as the actor does; its row. */
function storeFrame(
  h: { store: Store; id: ThreadId },
  seq: number,
  kind: string,
  operationId = "old",
) {
  const result = h.store.statement("INSERT INTO engine_provider_frames VALUES (?,?,?,?)").run(
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

test("a new turn on a long Cursor thread drops the settled turns' frames a bounded batch per commit", async () => {
  const h = await thread();
  const recovery = new ProviderRecovery(h.store);
  recovery.captured(h.id, "open", storeFrame(h, 1, "open"), false);
  for (let seq = 2; seq < 1002; seq++) storeFrame(h, seq, "delta");
  recovery.captured(h.id, "send", storeFrame(h, 1002, "send", "new"), true);
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
  recovery.captured(h.id, "open", storeFrame(h, 1, "open"), false);
  for (let seq = 2; seq < 600; seq++) storeFrame(h, seq, "delta");
  recovery.captured(h.id, "send", storeFrame(h, 600, "send", "new"), true);
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

test("a fresh session on a thread with many old frames sets them aside at once and deletes them in steps", async () => {
  const h = await thread();
  const recovery = new ProviderRecovery(h.store);
  recovery.captured(h.id, "open", storeFrame(h, 1, "open"), false);
  for (let seq = 2; seq < 1200; seq++) storeFrame(h, seq, "delta");
  recovery.reset(h.id);
  // Nothing of the old session is read again, though its frames are not all gone yet.
  expect(count(h)).toBe(1199);
  const seen: string[] = [];
  const reader = {
    translate(input: { data: unknown }) {
      seen.push(String((input.data as { kind?: string }).kind));
      return [];
    },
    tick: () => [],
  };
  await recovery.restore(h.id, reader);
  expect(seen).toEqual([]);
  // The fresh session's frames start a new record; the old ones go a batch per commit.
  recovery.captured(h.id, "open", storeFrame(h, 1200, "open", "fresh"), false);
  recovery.trimStep(h.id);
  expect(count(h)).toBe(1200 - 256);
  for (let step = 0; step < 10; step++) recovery.trimStep(h.id);
  expect(count(h)).toBe(1);
  await recovery.restore(h.id, reader);
  expect(seen).toEqual(["open"]);
});

test("a send in doubt keeps its delivery evidence through a fresh session, after the old frames are gone", async () => {
  const h = await thread();
  const recovery = new ProviderRecovery(h.store);
  recovery.captured(h.id, "open", storeFrame(h, 1, "open"), false);
  recovery.note(h.id, frame("send", { input: [], attemptedAt: 1, runFramed: true }));
  storeFrame(h, 2, "send", "send-1");
  // The saved session can't open again: the thread moves to a fresh one.
  recovery.reset(h.id);
  for (let step = 0; step < 4; step++) recovery.trimStep(h.id);
  recovery.captured(h.id, "open", storeFrame(h, 3, "open", "fresh"), false);
  for (let step = 0; step < 4; step++) recovery.trimStep(h.id);
  expect(count(h)).toBe(1);
  // It was attempted: never taken for a send that never reached Cursor, and never re-sent.
  expect(recovery.attempted(h.id, "send-1")).toBe(true);
  // Nothing the fresh session reads back settles it: it stays for the person.
  expect(recovery.lastAdmission(h.id)).toBeUndefined();
  // A send of the fresh session has a record of its own, and the old one is kept beside it.
  recovery.note(h.id, {
    ...frame("send", { input: [], attemptedAt: 2, runFramed: true }),
    commandId: "send-2",
    operationId: "send-2",
  });
  expect(recovery.attempted(h.id, "send-2")).toBe(true);
  expect(recovery.attempted(h.id, "send-1")).toBe(true);
});

test("the first reopen of a thread an earlier build left reads from its latest send, not its whole record", async () => {
  const h = await thread();
  const recovery = new ProviderRecovery(h.store);
  // No records of this build: an earlier build's frames, a long settled stretch, then a turn.
  storeFrame(h, 1, "open");
  for (let seq = 2; seq < 2000; seq++) storeFrame(h, seq, "delta");
  storeFrame(h, 2000, "send", "new");
  storeFrame(h, 2001, "delta", "new");
  const seen: string[] = [];
  await recovery.restore(h.id, {
    translate(input) {
      seen.push(String((input.data as { kind?: string }).kind));
      return [];
    },
    tick: () => [],
  });
  expect(seen).toEqual(["open", "send", "delta"]);
  // From then on it is this build's: its settled frames go a batch at a time.
  recovery.trimStep(h.id);
  expect(count(h)).toBe(2001 - 256);
});

test("an earlier build's send older than its newest 4,096 frames is held as attempted, never sent again", async () => {
  const h = await thread();
  // The send is the thread's second frame; past it, more frames than the newest window holds.
  h.store.atomic(() => {
    storeFrame(h, 1, "open");
    storeFrame(h, 2, "send", "old");
    for (let seq = 3; seq < 5000; seq++) storeFrame(h, seq, "host-output", "other");
  });
  // Startup asks before any reopen.
  const before = new ProviderRecovery(h.store);
  expect(before.attempted(h.id, "send-1")).toBe(true);
  expect(before.admissionRecorded(h.id, "send-1")).toBe(true);
  // And after the first reopen has made the thread this build's.
  await before.restore(h.id, { translate: () => [], tick: () => [] });
  const after = new ProviderRecovery(h.store);
  expect(after.attempted(h.id, "send-1")).toBe(true);
  expect(after.admissionRecorded(h.id, "send-1")).toBe(true);
});

test("a crash during an earlier build's first reopen still leaves its send's attempt on record", async () => {
  const h = await thread();
  storeFrame(h, 1, "open");
  storeFrame(h, 2, "send", "new");
  storeFrame(h, 3, "delta", "new");
  // The reopen dies as it replays the send (the daemon was killed there).
  await expect(
    new ProviderRecovery(h.store).restore(h.id, {
      translate(input) {
        if ((input.data as { kind?: string }).kind === "send") throw new Error("killed");
        return [];
      },
      tick: () => [],
    }),
  ).rejects.toThrow("killed");
  // The next boot still knows the send was attempted and that Cursor's run had output.
  const next = new ProviderRecovery(h.store);
  expect(next.attempted(h.id, "send-1")).toBe(true);
  expect(next.admissionRecorded(h.id, "send-1")).toBe(true);
});

test("an idle thread's settled frames go a bounded batch per sweep, with no new frame committed", async () => {
  const h = await thread();
  const recovery = new ProviderRecovery(h.store);
  recovery.captured(h.id, "open", storeFrame(h, 1, "open"), false);
  for (let seq = 2; seq < 700; seq++) storeFrame(h, seq, "delta");
  recovery.captured(h.id, "send", storeFrame(h, 700, "send", "new"), true);
  // The thread goes idle: nothing commits for it any more.
  recovery.pruneIdle();
  expect(count(h)).toBe(700 - 256);
  for (let sweep = 0; sweep < 4; sweep++) recovery.pruneIdle();
  expect(count(h)).toBe(2);
});
