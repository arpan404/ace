import { expect, test } from "vitest";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { SessionContext } from "@ace/engine-api";
import { Command, DeviceId, type CommandPayload } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { Client } from "../socket-test-support.ts";
import { ManualClock, scriptFrames, start, end, until } from "./test-support.ts";

test("daemon health reports provider sessions and held input then observes idle retirement", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-engine-health-"));
  const frames = scriptFrames();
  const clock = new ManualClock();
  const closed = Promise.withResolvers<void>();
  let context: SessionContext | undefined;
  const adapter = createScriptedAdapter({
    provider: "codex",
    capabilities: {
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    },
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [
      { on: "send", frames: [frames.frame(start)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
  });
  const registry = new AdapterRegistry();
  registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        context = ctx;
        const session = await adapter.openSession(ctx);
        return {
          ...session,
          async close(reason) {
            await session.close(reason);
            closed.resolve();
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: {
      registry,
      clock,
      idleMs: 500,
      silenceMs: 100,
      adapterDiscovery: async () => {
        throw new Error("Explicit registry must bypass discovery");
      },
    },
  });
  const client = new Client(daemon.url);
  try {
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("device"),
      token: readFileSync(daemon.tokenPath, "utf8"),
    });
    await until(client, (message) => message.type === "welcome");
    let seq = 0;
    async function command(payload: CommandPayload) {
      const id = `command-${++seq}`;
      client.send({ type: "command", command: Command.parse({ id, deviceId: "device", payload }) });
      return until(
        client,
        (message) => message.type === "commandResult" && message.commandId === id,
      );
    }
    expect(await command({ type: "diagnostics.health" })).toMatchObject({
      ok: true,
      health: { activeSessions: 0, queues: { "engine.queuedSends": 0 } },
    });
    const started = Promise.withResolvers<void>();
    const stop = daemon.store.subscribe((events) => {
      if (
        events.some(
          (event) =>
            event.payload.type === "thread.updated" && event.payload.status?.state === "working",
        )
      )
        started.resolve();
    });
    const workspaceId = daemon.store.createWorkspace(home, "Workspace");
    expect(
      await command({
        type: "thread.create",
        workspaceId,
        provider: "codex",
        input: [{ type: "text", text: "first" }],
      }),
    ).toMatchObject({ ok: true });
    await started.promise;
    stop();
    const thread = daemon.store.listThreads()[0];
    if (!thread) throw new Error("Missing thread");
    expect(
      await command({
        type: "thread.send",
        threadId: thread.id,
        input: [{ type: "text", text: "held" }],
        delivery: "queue",
      }),
    ).toMatchObject({ ok: true });
    expect(await command({ type: "diagnostics.health" })).toMatchObject({
      ok: true,
      health: {
        activeSessions: 1,
        queues: { "engine.queuedSends": 1, "daemon.healthRequests": 1 },
      },
    });
    const done = Promise.withResolvers<void>();
    const stopDone = daemon.store.subscribe((events) => {
      if (
        events.some(
          (event) =>
            event.payload.type === "thread.updated" && event.payload.status?.state === "done",
        )
      )
        done.resolve();
    });
    if (!context) throw new Error("Missing provider session");
    context.onFrame(frames.frame(end));
    await done.promise;
    stopDone();
    expect(await command({ type: "diagnostics.health" })).toMatchObject({
      ok: true,
      health: { activeSessions: 1, queues: { "engine.queuedSends": 0 } },
    });
    clock.advance(1500);
    await closed.promise;
    expect(await command({ type: "diagnostics.health" })).toMatchObject({
      ok: true,
      health: { activeSessions: 0, queues: { "engine.queuedSends": 0 } },
    });
    expect(adapter.commands.filter((entry) => entry.type === "send")).toHaveLength(2);
    expect(adapter.commands.at(-1)).toEqual({ type: "close", reason: "idle" });
  } finally {
    await client.close();
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
