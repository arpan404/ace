import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareDaemonHome } from "@ace/service";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities, Command, type CommandPayload } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { ManualClock, scriptFrames, start } from "./engine/test-support.ts";

/*
 * ADR 0041: while maintenance holds new work, turns ace would start by itself wait. A daemon
 * started with ACE_MAINTENANCE=1 must not continue a turn its last shutdown cut short until the
 * gate reopens, even though startup recovery runs before the server is listening.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).toReversed()) await close();
  } finally {
    vi.unstubAllEnvs();
  }
});

const capabilities = Capabilities.parse({
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: true,
  backgroundTaskControl: false,
  backgroundVisibility: "full",
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
});

/** A provider whose turns start and never end, so a shutdown always cuts one short. */
function provider() {
  const frames = scriptFrames();
  const adapter = createScriptedAdapter({
    provider: "codex",
    capabilities,
    nativeSessionId: "native-maintenance",
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [frames.frame(start)] }],
  });
  const registry = new AdapterRegistry();
  registry.register(adapter, { installed: true, auth: "logged_in", loginHint: "synthetic" });
  const sends = () => adapter.commands.filter((command) => command.type === "send");
  return { registry, sends };
}

async function daemonAt(home: string, registry: AdapterRegistry, clock: ManualClock) {
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    history: { instances: [] },
    modelInstances: [],
    engine: { registry, clock },
  });
  const engine = daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  return { daemon, engine };
}

it("a daemon started in maintenance holds a restart continuation until admission reopens", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-restart-maintenance-"));
  prepareDaemonHome(home);
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv("ACE_ACCOUNTS_DB", join(home, "accounts.sqlite"));
  vi.stubEnv("ACE_MAINTENANCE", "0");
  const clock = new ManualClock();

  const before = provider();
  const first = await daemonAt(home, before.registry, clock);
  const workspace = first.daemon.store.createWorkspace(home, "Maintenance");
  const payload: CommandPayload = {
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    input: [{ type: "text", text: "Long task" }],
  };
  const command = Command.parse({ id: "create-long", deviceId: "device", payload });
  const created = first.daemon.store.recordCommand(command.id, command.deviceId, () =>
    first.engine.handler.handle(command, first.daemon.store),
  );
  expect(created.ok).toBe(true);
  await first.engine.flush();
  const id = first.daemon.store.listThreads()[0]?.id;
  if (!id) throw new Error("Missing thread");
  expect(first.daemon.store.getThread(id)?.status.state).toBe("working");
  await first.daemon.close();
  await before.registry.close();

  vi.stubEnv("ACE_MAINTENANCE", "1");
  const after = provider();
  cleanups.push(() => after.registry.close());
  const second = await daemonAt(home, after.registry, clock);
  cleanups.push(() => second.daemon.close());
  await second.engine.flush();
  clock.advance(clock.now() + 60_000);
  await second.engine.flush();
  expect(second.daemon.maintenance.status().draining).toBe(true);
  expect(after.sends()).toEqual([]);

  second.daemon.maintenance.leave();
  clock.advance(clock.now());
  await second.engine.flush();
  const sent = after.sends();
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0]?.input)).toContain("ace restarted while you were working");
});
