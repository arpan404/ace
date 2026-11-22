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
