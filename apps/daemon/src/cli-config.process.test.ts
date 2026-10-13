import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, type ThreadId } from "@ace/protocol";
import { scriptedProvider } from "../bench/scripted.ts";
import { startDaemon, readConfig, AdapterRegistry } from "./index.ts";
import { ManualClock } from "./engine/test-support.ts";
import { invoke } from "./cli-test-support.ts";

const day = 86400000;
async function runningDaemon(environment: NodeJS.ProcessEnv = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-cli-config-"));
  const clock = new ManualClock();
  const provider = scriptedProvider();
  const registry = new AdapterRegistry();
  registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
  const daemon = await startDaemon({
    config: readConfig({ ...environment, ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: { registry, clock },
    modelInstances: [],
    // No startup pass inside the test; a changed window applies after 20 ms.
    retentionTiming: { startupMs: 3600_000, intervalMs: 3600_000, changeMs: 20, retryMs: 50 },
  });
  const engine = daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const workspaceId = daemon.store.createWorkspace(home, "Project");
  /** A real engine thread, left running until `finish`. */
  const start = async (text: string) => {
    const command = Command.parse({
      id: `create-${text}`,
      deviceId: "fixture",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "codex",
        input: [{ type: "text", text }],
      },
    });
    const result = daemon.store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, daemon.store),
    );
    if (!result.ok || !result.threadId) throw new Error("Thread was not created");
    await engine.flush();
    return result.threadId;
  };
  const finish = async (id: ThreadId) => {
    await provider.finish(id);
    await engine.flush();
  };
  const deleted = (id: ThreadId) => daemon.store.getThread(id)?.deletedAt !== undefined;
  return {
    home,
    daemon,
    clock,
    start,
    finish,
    deleted,
    async close() {
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("ace config set retention-days applies to the running daemon at once and keeps live threads", async () => {
  const f = await runningDaemon();
  try {
    const idle = await f.start("idle for 100 days");
    await f.finish(idle);
    const working = await f.start("working for 100 days");
    f.clock.advance(f.clock.now() + 100 * day);
    const recent = await f.start("finished today");
    await f.finish(recent);
    expect(f.daemon.store.getThread(working)?.status.state).not.toBe("done");
    const before = await invoke(f.home, ["config", "get", "retention-days", "--json"]);
    expect(before.code, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({ value: 120, source: "default", live: true });

    const set = await invoke(f.home, ["config", "set", "retention-days", "90", "--json"]);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ value: 90, source: "saved", live: true });
    // No restart: the daemon's next pass uses the new window.
    await expect.poll(() => f.deleted(idle), { timeout: 10_000 }).toBe(true);
    for (const kept of [working, recent]) expect(f.deleted(kept)).toBe(false);

    const refused = await invoke(f.home, ["config", "set", "retention-days", "0", "--json"]);
    expect(refused.code).toBe(4);
    expect(JSON.parse(refused.stdout).error).toContain("retention-days must be");
  } finally {
    await f.close();
  }
});

test("an environment override wins over a saved value and the CLI says so", async () => {
  const f = await runningDaemon({ ACE_RETENTION_DAYS: "365" });
  try {
    const idle = await f.start("idle for 100 days");
    await f.finish(idle);
    f.clock.advance(f.clock.now() + 100 * day);
    const set = await invoke(f.home, ["config", "set", "retention-days", "30", "--json"]);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      value: 365,
      source: "environment",
      overriddenBy: "ACE_RETENTION_DAYS",
    });
    const human = await invoke(f.home, ["config", "get", "retention-days"]);
    expect(human.stdout).toContain("ACE_RETENTION_DAYS overrides the saved value");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(f.deleted(idle)).toBe(false);
  } finally {
    await f.close();
  }
});

test("ace config set log-cap shrinks the running daemon's log files without a restart", async () => {
  const f = await runningDaemon();
  try {
    const logs = join(f.home, "logs");
    await mkdir(logs, { recursive: true });
    for (let n = 1; n <= 6; n++)
      await writeFile(join(logs, `ace.${n}.jsonl`), "x".repeat(512 * 1024));
    const set = await invoke(f.home, ["config", "set", "log-cap", "2m", "--json"]);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ value: 2 * 1024 * 1024, source: "saved" });
    const total = async () =>
      (await Promise.all((await readdir(logs)).map((name) => stat(join(logs, name))))).reduce(
        (sum, file) => sum + file.size,
        0,
      );
    await expect.poll(total, { timeout: 10_000 }).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally {
    await f.close();
  }
});

test("with no daemon running, ace config set saves the value for the next start", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-cli-config-offline-"));
  try {
    const set = await invoke(home, ["config", "set", "retention-days", "45", "--json"]);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ value: 45, source: "saved", live: false });
    const get = await invoke(home, ["config", "get", "--json"]);
    expect(JSON.parse(get.stdout)).toEqual([
      expect.objectContaining({ setting: "retention-days", value: 45 }),
      expect.objectContaining({ setting: "log-cap", value: 1024 ** 3, source: "default" }),
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
