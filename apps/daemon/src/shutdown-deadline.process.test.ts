import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { spawnRawSupervised, type RawSupervisedProcess } from "@ace/provider-kit/process";
import { Command, DeviceId } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "./index.ts";
import { commandContext } from "./commands.ts";
import { daemonLogRecords } from "./daemon-log-test-support.ts";
import { scriptFrames, start } from "./engine/test-support.ts";
import { Client } from "./socket-test-support.ts";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/**
 * A provider whose native process ignores SIGTERM and whose own close waits out a long grace
 * period, as a busy CLI does while it interrupts turns and reaps its shells.
 */
function stubbornProvider() {
  const frames = scriptFrames();
  const started = frames.frame(start);
  const children: RawSupervisedProcess[] = [];
  const scripted = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native-stubborn",
    capabilities: {
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: false,
      backgroundTaskControl: false,
      backgroundVisibility: "none",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    },
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [started] }],
  });
  const registry = new AdapterRegistry();
  registry.register(
    {
      ...scripted,
      async openSession(context) {
        const child = spawnRawSupervised({
          command: process.execPath,
          args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
          env: process.env,
          name: "stubborn-provider",
        });
        children.push(child);
        const session = await scripted.openSession(context);
        return Object.assign(session, {
          async close() {
            await child.stop({ graceMs: 30_000 });
          },
        });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  return { registry, children };
}

test("shutdown with a live provider child and an open socket finishes before the deadline and records a clean stop", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-shutdown-deadline-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const provider = stubbornProvider();
  cleanups.push(() => {
    for (const child of provider.children) void child.stop({ graceMs: 0 });
  });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "info" }),
    modelInstances: [],
    history: { instances: [] },
    engine: { registry: provider.registry },
  });
  cleanups.push(() => daemon.close().catch(() => {}));
  const client = new Client(daemon.url);
  cleanups.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("desktop"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  const workspaceId = daemon.store.createWorkspace(home, "Workspace");
  const create = Command.parse({
    id: randomUUID(),
    deviceId: "host",
    createdAt: 1,
    payload: {
      type: "thread.create",
      workspaceId,
      provider: "codex",
      input: [{ type: "text", text: "keep working" }],
    },
  });
  expect(daemon.engine?.handler.handle(create, commandContext(daemon.store)).ok).toBe(true);
  await daemon.engine?.flush();
  const thread = daemon.store.listThreads()[0];
  if (!thread) throw new Error("Missing thread");
  expect(thread.status.state).toBe("working");
  expect(provider.children).toHaveLength(1);

  const began = performance.now();
  await daemon.close({ source: "signal", signal: "SIGTERM" });
  const elapsed = performance.now() - began;

  // The forced stop follows the polite window well inside the 7 s deadline.
  expect(elapsed).toBeLessThan(5_000);
  expect(JSON.parse(await readFile(join(home, "daemon-run.json"), "utf8"))).toMatchObject({
    state: "stopped",
    source: "signal",
    signal: "SIGTERM",
  });
  const records = await daemonLogRecords(home);
  expect(records.map((record) => record.message)).toContain("Daemon stopped");
  expect(records.map((record) => record.message)).not.toContain(
    "Daemon shutdown deadline exceeded",
  );
  const forced = records.find((record) =>
    record.message.startsWith("Daemon shutdown is stopping child processes"),
  );
  expect(JSON.stringify(forced?.data)).toContain("service engine");
  // The turn that was cut off is never reported as finished, nor as still working.
  const store = new Store(join(home, "events.sqlite"));
  try {
    const state = store.listThreads()[0]?.status.state;
    expect(state).not.toBe("done");
    expect(state).not.toBe("working");
  } finally {
    await store.close();
  }
});
