import { expect, it } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { cursorCapabilities } from "@ace/adapter-cursor";
import { Engine, AdapterRegistry } from "@ace/daemon";
import { Command, ThreadId } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";
import { scriptFrames, start, end, ManualClock } from "./engine/test-support.ts";

it("socket context handoff refuses unreadable source history before admission and accepts an authorized source", async () => {
  let engine: Engine | undefined;
  const f = await fixture({
    canReadThread: (_device, id) => id !== ThreadId.parse("denied"),
    handler: {
      handle: (command, context) => {
        if (!engine) throw new Error("Missing public engine");
        return engine.handler.handle(command, context);
      },
    },
  });
  const frames = scriptFrames();
  const adapter = createScriptedAdapter({
    provider: "cursor",
    nativeSessionId: "fresh-sdk-agent",
    capabilities: cursorCapabilities,
    steps: [{ on: "send", frames: [frames.frame(start, end)] }],
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
  });
  const registry = new AdapterRegistry();
  registry.register(
    { ...adapter, backend: "cursor-sdk" },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  engine = new Engine(f.store, { registry, clock: new ManualClock() });
  try {
    const workspaceId = f.store.createWorkspace(f.home, "SDK workspace");
    const denied = { ...f.thread, id: ThreadId.parse("denied") };
    f.store.appendEvents(denied.id, [{ type: "thread.created", thread: denied }]);
    const count = f.store.listThreads().length;
    const client = await f.connect();
    await client.next();
    client.send({
      type: "command",
      command: Command.parse({
        id: "denied-handoff",
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "cursor",
          handoffFrom: denied.id,
          input: [{ type: "text", text: "continue source" }],
        },
      }),
    });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      commandId: "denied-handoff",
      ok: false,
      error: "handoff_source_not_found",
    });
    await engine.flush();
    expect(f.store.listThreads()).toHaveLength(count);
    client.send({
      type: "command",
      command: Command.parse({
        id: "allowed-handoff",
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "cursor",
          handoffFrom: f.thread.id,
          input: [{ type: "text", text: "continue source" }],
        },
      }),
    });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      commandId: "allowed-handoff",
      ok: true,
    });
    await engine.flush();
    expect(f.store.listThreads()).toHaveLength(count + 1);
    expect(f.store.listThreads().find((thread) => thread.handoff)?.handoff?.sourceThreadId).toBe(
      f.thread.id,
    );
  } finally {
    await engine.close();
    await f.close();
  }
});
