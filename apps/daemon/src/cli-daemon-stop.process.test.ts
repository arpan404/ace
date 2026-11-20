import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { invoke } from "./cli-test-support.ts";

/*
 * `ace stop` against a real daemon whose provider left processes behind: a Codex app-server
 * (an offline fake) with one child in its process group and one in a session of its own that
 * holds the app-server's stdout and stderr, as a shell a real agent backgrounds can. The group
 * signal never reaches the second, and its pipe kept the stopped daemon's process alive.
 */
const fakeCodex = new URL("../../../packages/adapter-codex/src/testing/cli.ts", import.meta.url);
const cli = new URL("./cli.ts", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recorded(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(Number);
}

async function until(check: () => boolean, what: string, milliseconds = 20_000) {
  for (let waited = 0; waited < milliseconds; waited += 100) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test.skipIf(process.platform === "win32")(
  "ace stop leaves nothing of the daemon or its provider's process tree running",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-daemon-stop-"));
    const home = join(root, "ace");
    const person = join(root, "home");
    const bin = join(root, "bin");
    const pids = join(root, "provider-pids");
    await Promise.all([
      mkdir(home),
      mkdir(join(person, "project"), { recursive: true }),
      mkdir(bin),
    ]);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => {
      // Only processes this test's fake provider recorded.
      for (const pid of recorded(pids)) if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    await writeFile(
      join(bin, "codex"),
      [
        `#!${process.execPath}`,
        'import { spawn } from "node:child_process";',
        'import { appendFileSync } from "node:fs";',
        // A turn's work: what an agent's shells start once its turn begins.
        "let started = false;",
        "const write = process.stdout.write.bind(process.stdout);",
        "process.stdout.write = (chunk, ...rest) => {",
        "  if (!started && String(chunk).includes('\"turn/started\"')) {",
        "    started = true;",
        '    const inGroup = spawn("sleep", ["300"], { stdio: "ignore" });',
        '    const away = spawn("sleep", ["301"], { stdio: ["ignore", "inherit", "inherit"], detached: true });',
        "    away.unref();",
        `    appendFileSync(${JSON.stringify(pids)}, [process.pid, inGroup.pid, away.pid].join("\\n") + "\\n");`,
        "  }",
        "  return write(chunk, ...rest);",
        "};",
        `await import(${JSON.stringify(fakeCodex.href)});`,
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "codex"), 0o755);
    const env = {
      ACE_HOME: home,
      HOME: person,
      PATH: `${bin}:/usr/bin:/bin`,
      ACE_LOG_LEVEL: "silent",
      ACE_LISTEN: "local",
      ACE_MAINTENANCE: "0",
      ACE_DEV: "0",
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_APNS_KEY_FILE: "",
      ACE_VAPID_KEY_FILE: "",
      ACE_RELAY_URL: undefined,
      ACE_SCREEN_HELPER: undefined,
    };
    const daemon = spawn(process.execPath, [cli, "start"], {
      env: { ...process.env, ...env, ACE_PORT: "0" },
      stdio: "ignore",
    });
    const daemonExit = once(daemon, "exit");
    cleanups.push(() => {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    });
    await until(() => existsSync(join(home, "daemon-endpoint")), "the daemon to listen", 30_000);

    const started = await invoke(
      home,
      ["run", "Say hello", "--project", join(person, "project"), "--provider", "codex", "--json"],
      "",
      env,
    );
    expect(started.code, started.stderr + started.stdout).toBe(0);
    // A thread's app-server, its grouped child and the one that left its group are running.
    await until(() => recorded(pids).length >= 3, "the provider's processes");
    const tree = recorded(pids);
    expect(tree.every(alive)).toBe(true);

    const stopped = await invoke(home, ["stop", "--json", "--timeout", "20s"], "", env);
    expect(stopped.code, stopped.stderr).toBe(0);
    const answer: unknown = JSON.parse(stopped.stdout);
    expect(answer).toMatchObject({ stopped: true });
    // The daemon's own shutdown ended its tree, as it must when a service manager or the app
    // stops it with no `ace stop` to clean up after it.
    expect(answer).not.toHaveProperty("leftoversStopped");
    // Done means done: when stop returns, the daemon and every provider process have ended.
    // (The daemon is this test's child, so its exit event, not kill(0), says it is gone.)
    const exited = await Promise.race([
      daemonExit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(exited).toBe(true);
    expect(recorded(pids).filter(alive)).toEqual([]);
  },
  90_000,
);
