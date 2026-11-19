import { createHash } from "node:crypto";
import { Store, readConfig } from "@ace/daemon";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { expect, onTestFinished, test, vi } from "vitest";
import { openRegistry, openRegistryIndex } from "@ace/accounts";
import { fileURLToPath } from "node:url";
import { assertRealDaemonEnvironment, realDaemonEnvironment } from "./real-daemon-environment.ts";
import { defaultTmpRoot, e2eLayout } from "./real-daemon-layout.ts";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Waits, bounded by the test timeout, until the live daemon commits a scripted reply. */
async function scriptedReplyCommitted(path: string): Promise<void> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const reply = db.prepare(
      "SELECT 1 FROM events WHERE type IN ('item.created','item.updated') AND instr(payload, ?) > 0 AND instr(payload, '\"assistant\"') > 0 LIMIT 1",
    );
    while (!reply.get("Hello from the scripted provider.")) await delay(25);
  } finally {
    db.close();
  }
}

const launcher = fileURLToPath(new URL("./real-daemon-launcher.ts", import.meta.url));

/** A launch environment holding nothing of the machine's: HOME, PATH and selectors are invented. */
async function fixture(onFinished: (cleanup: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), "ace-e2e-isolation-"));
  const name = `fixture-${basename(root)}`;
  const layout = e2eLayout(defaultTmpRoot(process.platform, tmpdir()), name);
  onFinished(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(layout.daemonHome, { recursive: true, force: true });
    await rm(layout.projectsRoot, { recursive: true, force: true });
  });
  const external = join(root, "external");
  const bin = join(root, "bin");
  await Promise.all([mkdir(external), mkdir(join(root, "launch-home")), mkdir(bin)]);
  await symlink("/usr/bin/git", join(bin, "git"));
  await symlink(process.execPath, join(bin, "node"));
  // The launcher itself replaces its HOME and rejects escaped selectors. Keep all
  // invented external state inside this test, and give discovery no provider CLIs.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "launch-home"),
    PATH: bin,
    CODEX_HOME: external,
    CLAUDE_CONFIG_DIR: external,
    PI_CODING_AGENT_DIR: external,
    XDG_CONFIG_HOME: external,
    XDG_DATA_HOME: external,
    ACE_E2E_DAEMON_HOME: name,
    ACE_E2E_DAEMON_PORT: "0",
    ACE_E2E_LONG_TURNS: "0",
  };
  delete env.ACE_TEST_REAL_HOME;
  return { root, external, layout, env };
}

function launch(env: NodeJS.ProcessEnv, onFinished: (cleanup: () => Promise<void>) => void) {
  const child = spawn(process.execPath, [launcher], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const ready = Promise.withResolvers<number>();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const pid = /e2e daemon ready on \S+ \(pid (\d+)\)/.exec(output)?.[1];
    if (pid) ready.resolve(Number(pid));
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", ready.reject);
  child.on("exit", () => ready.reject(new Error(`Launcher exited before readiness: ${stderr}`)));
  // Settled here so a launch that is meant to fail leaves no unhandled rejection.
  ready.promise.catch(() => {});
  onFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  });
  return { child, exited, ready: ready.promise, stderr: () => stderr };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the real e2e launcher ignores inherited account and provider paths and serves scripted threads", async () => {
  const { root, external, layout, env } = await fixture(onTestFinished);
  const database = join(external, "accounts.sqlite");
  const registry = await openRegistryIndex(database);
  registry.close();
  const before = hash(await readFile(database));
  await writeFile(join(external, "sentinel"), "unchanged");
  // A preload the caller's Bun options carry: it may run in a launcher on Bun, never in the daemon.
  const marks = join(root, "preloaded");
  const preload = join(root, "preload.mjs");
  await writeFile(
    preload,
    `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marks)}, (process.argv[1] ?? "") + "\\n");`,
  );
  const daemon = launch(
    { ...env, ACE_ACCOUNTS_DB: database, BUN_OPTIONS: `--preload ${preload}` },
    onTestFinished,
  );
  await daemon.ready;
  // Readiness follows seeding; the seeded thread's scripted turn settles afterwards.
  await scriptedReplyCommitted(join(layout.daemonHome, "events.sqlite"));
  daemon.child.kill("SIGTERM");
  expect(await daemon.exited).toEqual([0, null]);
  const preloaded = (await readFile(marks, "utf8").catch(() => "")).split("\n").filter(Boolean);
  if (process.versions.bun) expect(preloaded).toContain(launcher);
  expect(preloaded.filter((script) => script.endsWith("real-daemon.ts"))).toEqual([]);
  expect(hash(await readFile(database))).toBe(before);
  expect(await readFile(join(external, "sentinel"), "utf8")).toBe("unchanged");
  const store = new Store(join(layout.daemonHome, "events.sqlite"));
  try {
    expect(
      store.listThreads().some((thread) => thread.title === "Smoke test on a real daemon"),
    ).toBe(true);
    expect(
      store
        .readEvents({ afterSeq: 0, limit: 1000 })
        .some(
          ({ payload }) =>
            (payload.type === "item.created" || payload.type === "item.updated") &&
            payload.item.type === "message" &&
            payload.item.role === "assistant" &&
            payload.item.parts.some(
              (part) => part.type === "text" && part.text === "Hello from the scripted provider.",
            ),
        ),
    ).toBe(true);
  } finally {
    store.close();
  }
  // Reading accounts waits for their homes to be validated.
  const fixtureRegistry = await openRegistry(join(layout.daemonHome, "accounts.sqlite"));
  try {
    expect(fixtureRegistry.list().map((row) => row.instance.id)).toContain("codex-cli-default");
  } finally {
    fixtureRegistry.close();
  }
});

test("the e2e daemon stops when its launcher is killed outright", async () => {
  const { env } = await fixture(onTestFinished);
  const daemon = launch(env, onTestFinished);
  const pid = await daemon.ready;
  onTestFinished(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  daemon.child.kill("SIGKILL");
  await daemon.exited;
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000, interval: 50 });
});

test("inherited fixture paths and a name that leaves the fixture root are refused before anything is removed", async () => {
  const { root, env } = await fixture(onTestFinished);
  const kept = join(root, "kept");
  await mkdir(kept);
  await writeFile(join(kept, "sentinel"), "unchanged");
  for (const [variables, message] of [
    [{ ACE_E2E_PROJECTS_PATH: kept }, "takes no paths from the environment"],
    [{ ACE_E2E_DAEMON_PATH: kept, ACE_E2E_ROOT: kept }, "takes no paths from the environment"],
    [{ ACE_E2E_DAEMON_HOME: "../kept" }, "must be a plain folder name"],
  ] as const) {
    const refused = launch({ ...env, ...variables }, onTestFinished);
    await expect(refused.ready).rejects.toThrow(message);
    expect((await refused.exited)[0]).not.toBe(0);
  }
  expect(await readFile(join(kept, "sentinel"), "utf8")).toBe("unchanged");
});

test("launcher configuration protects the original home and refuses a restored external registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-e2e-guard-"));
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "fixture");
  const protectedHome = join(root, "protected");
  const external = join(root, "external");
  await Promise.all([mkdir(home), mkdir(protectedHome), mkdir(external)]);
  const env = realDaemonEnvironment(
    {
      HOME: protectedHome,
      ACE_ACCOUNTS_DB: join(external, "accounts.sqlite"),
      CODEX_HOME: protectedHome,
      ACE_E2E_DAEMON_HOME: "guard-fixture",
    },
    home,
    protectedHome,
  );
  // Apply the launcher's environment before configuration, just as its entrypoint does.
  vi.stubEnv("ACE_TEST_REAL_HOME", env.ACE_TEST_REAL_HOME);
  await assertRealDaemonEnvironment(env, home);
  expect(readConfig(env).dataDir).toBe(home);
  expect(() =>
    readConfig({ ...env, ACE_ACCOUNTS_DB: join(protectedHome, "accounts.sqlite") }),
  ).toThrow("ACE_TEST_REAL_HOME guard refused");
  await expect(
    assertRealDaemonEnvironment(
      { ...env, ACE_ACCOUNTS_DB: join(external, "accounts.sqlite") },
      home,
    ),
  ).rejects.toThrow("ACE_ACCOUNTS_DB escapes the fixture home");
  await symlink(external, join(home, "escaped"));
  await expect(
    assertRealDaemonEnvironment({ ...env, CODEX_HOME: join(home, "escaped") }, home),
  ).rejects.toThrow("CODEX_HOME escapes the fixture home");
});
