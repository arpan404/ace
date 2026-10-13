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
import { assertRealDaemonEnvironment, realDaemonEnvironment } from "./real-daemon-environment.ts";

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

test("the real e2e launcher ignores inherited account and provider paths and serves scripted threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-e2e-isolation-"));
  const external = join(root, "external");
  const bin = join(root, "bin");
  await mkdir(external);
  await mkdir(join(root, "launch-home"));
  await mkdir(bin);
  await symlink("/usr/bin/git", join(bin, "git"));
  await symlink(process.execPath, join(bin, "node"));
  const database = join(external, "accounts.sqlite");
  const registry = await openRegistryIndex(database);
  registry.close();
  const before = hash(await readFile(database));
  await writeFile(join(external, "sentinel"), "unchanged");
  const name = `fixture-${basename(root)}`;
  const daemonHome = join(tmpdir(), name);
  // The launcher itself replaces its HOME and rejects escaped selectors. Keep all
  // invented external state inside this test, and give discovery no provider CLIs.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "launch-home"),
    PATH: bin,
    ACE_ACCOUNTS_DB: database,
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
  const child = spawn(process.execPath, [new URL("./real-daemon.ts", import.meta.url).pathname], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const ready = Promise.withResolvers<void>();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("e2e daemon ready")) ready.resolve();
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", ready.reject);
  child.on("exit", () => ready.reject(new Error(`Launcher exited before readiness: ${stderr}`)));
  try {
    await ready.promise;
    // Readiness follows seeding; the seeded thread's scripted turn settles afterwards.
    await scriptedReplyCommitted(join(daemonHome, "events.sqlite"));
    child.kill("SIGTERM");
    await exited;
    expect(hash(await readFile(database))).toBe(before);
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("unchanged");
    const store = new Store(join(daemonHome, "events.sqlite"));
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
    const fixtureRegistry = await openRegistry(join(daemonHome, "accounts.sqlite"));
    try {
      expect(fixtureRegistry.list().map((row) => row.instance.id)).toContain("codex-cli-default");
    } finally {
      fixtureRegistry.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
    await rm(daemonHome, { recursive: true, force: true });
    await rm(join("/tmp", `${name}-projects`), { recursive: true, force: true });
  }
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
