import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { cursorCapabilities } from "@ace/adapter-cursor";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";

it("rejects oversized SDK input before creating a thread and fences the durable input backlog", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-admission-"));
  const store = new Store(join(home, "state.sqlite"));
  const workspace = store.createWorkspace(home, "Workspace");
  const adapter = createScriptedAdapter({
    provider: "cursor",
    capabilities: cursorCapabilities,
    steps: [],
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
  });
  const registry = new AdapterRegistry();
  registry.register(
    { ...adapter, backend: "cursor-sdk" },
    { installed: false, auth: "unknown", loginHint: "unused" },
  );
  const engine = new Engine(store, {
    registry,
    threadId: () => "bounded-sdk-thread",
    limits: { maxInputBytes: 256, maxPendingInputs: 2 },
  });
  let sequence = 0;
  const command = (payload: CommandPayload) =>
    engine.handler.handle(
      Command.parse({ id: `input-${++sequence}`, deviceId: "device", payload }),
      store,
    );
  try {
    expect(
      command({
        type: "thread.create",
        provider: "cursor",
        workspaceId: workspace,
        input: [{ type: "text", text: "x".repeat(512) }],
      }),
    ).toMatchObject({ ok: false, error: "provider_input_budget_exceeded" });
    expect(store.listThreads()).toEqual([]);
    expect(
      command({
        type: "thread.create",
        provider: "cursor",
        workspaceId: workspace,
        input: [{ type: "text", text: "first" }],
      }),
    ).toMatchObject({ ok: true });
    const send = {
      type: "thread.send",
      delivery: "queue",
      threadId: ThreadId.parse("bounded-sdk-thread"),
      input: [{ type: "text", text: "queued" }],
    } satisfies CommandPayload;
    expect(command(send)).toMatchObject({ ok: true });
    expect(command(send)).toMatchObject({ ok: false, error: "provider_input_queue_full" });
    expect(command({ ...send, input: [{ type: "text", text: "x".repeat(512) }] })).toMatchObject({
      ok: false,
      error: "provider_input_budget_exceeded",
    });
  } finally {
    await engine.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
