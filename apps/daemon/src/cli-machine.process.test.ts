import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliOutputs } from "@ace/protocol/cli-outputs";
import { afterEach, describe, expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

/*
 * The machine entry points and the rescue path, through the real `ace` (ADR 0176 §13, ADR 0092):
 * what the desktop app and the release runtime read stays the same, bare `ace` off a terminal
 * starts nothing, and help, version, completion, doctor and triage work with the daemon down and
 * with another command's module broken.
 */

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A temp home and an empty HOME, so nothing reaches the person's own. */
async function emptyHome() {
  const root = await mkdtemp(join(tmpdir(), "ace-cli-machine-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const user = join(root, "user");
  const env = {
    HOME: user,
    USERPROFILE: user,
    ACE_HOME: home,
    ACE_WORKSPACE_ROOT: home,
    ACE_MAINTENANCE: "1",
    ACE_PORT: "0",
    ACE_LISTEN: "local",
    ACE_MODEL_INSTANCES: "[]",
    ACE_HISTORY_INSTANCES: "[]",
    ACE_RELAY_URL: undefined,
    ACE_THREAD_ID: undefined,
  };
  return { root, home, env };
}

/** Runs the CLI with `node`, optionally with a loader hook. */
function run(args: string[], env: NodeJS.ProcessEnv, preload?: string) {
  const child = spawn(process.execPath, [...(preload ? ["--import", preload] : []), cli, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => (stdout += bytes.toString()));
  child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("ace start --json prints the same keys the desktop app reads, then keeps running", async () => {
  const { home, env } = await emptyHome();
  const child = spawn(process.execPath, [cli, "start", "--json"], {
    env: { ...process.env, ...env, PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
      const end = stdout.indexOf("\n");
      if (end >= 0) resolve(stdout.slice(0, end));
    });
    void exited.then(() => reject(new Error(`ace start exited: ${stderr}`)));
  });
  const started: unknown = JSON.parse(line);
  expect(Object.keys(started as object)).toEqual(
    expect.arrayContaining(["running", "url", "tokenPath"]),
  );
  for (const key of Object.keys(started as object))
    expect(["running", "url", "tokenPath", "remoteUrl", "fingerprint"]).toContain(key);
  expect(cliOutputs["daemon.start"].parse(started)).toMatchObject({
    running: true,
    tokenPath: join(home, "daemon-token"),
  });
  expect(child.exitCode).toBe(null);
}, 60_000);

test("ace doctor --json prints the report the desktop app reads, with the daemon down", async () => {
  const { env } = await emptyHome();
  const result = await run(["doctor", "--json"], { ...env, PATH: "/usr/bin:/bin" });
  expect([0, 1]).toContain(result.code);
  const report: unknown = JSON.parse(result.stdout);
  expect(Object.keys(report as object).toSorted()).toEqual(["at", "checks", "planned", "repairs"]);
  expect(() => cliOutputs.doctor.parse(report)).not.toThrow();
}, 60_000);

test("bare ace without a terminal prints the overview, exits 0 and starts nothing", async () => {
  const { home, env } = await emptyHome();
  const result = await run([], env);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("ace help COMMAND for more.");
  const made = await readdir(home).catch(() => []);
  expect(
    made.filter((name) => ["daemon-endpoint", "daemon-token", "events.sqlite"].includes(name)),
  ).toEqual([]);
});

describe("help, version, completion, doctor and triage work when the rest of ace can't", () => {
  test("with the daemon down", async () => {
    const { env } = await emptyHome();
    for (const args of [
      ["help"],
      ["help", "storage", "clean"],
      ["version"],
      ["completion", "zsh"],
      ["doctor", "-h"],
    ]) {
      const result = await run(args, env);
      expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    }
    const triage = await run(["triage", "--print"], { ...env, PATH: "" });
    expect(triage.code, triage.stderr).toBe(0);
    expect(triage.stdout).toContain("# ace triage playbook");
  }, 60_000);

  // A broken install is simulated with Node's module hooks, which Bun lacks; the CLI's own
  // module graph is the same on either runtime.
  test.skipIf(Boolean(process.versions.bun))(
    "with other commands' modules broken",
    async () => {
      const { root, env } = await emptyHome();
      const hook = join(root, "broken.mjs");
      const broken = [
        "threads.ts",
        "retention.ts",
        "config.ts",
        "spade.ts",
        "market.ts",
        "automations.ts",
      ];
      await writeFile(
        hook,
        `import { registerHooks } from "node:module";
const broken = ${JSON.stringify(broken)};
registerHooks({
  load(url, context, next) {
    if (broken.some((name) => url.endsWith("/apps/daemon/src/cli/" + name)))
      return { format: "module", source: "throw new Error('broken module');", shortCircuit: true };
    return next(url, context);
  },
});
`,
      );
      for (const args of [
        ["help"],
        ["version"],
        ["completion", "bash"],
        ["doctor", "--json"],
        ["triage", "--print"],
      ]) {
        const result = await run(args, { ...env, PATH: "/usr/bin:/bin" }, hook);
        expect([0, 1], `${args.join(" ")}: ${result.stderr}`).toContain(result.code);
        expect(result.stdout.length).toBeGreaterThan(0);
        expect(result.stderr).not.toContain("broken module");
      }
      // The broken command fails on its own, and says how to get help.
      const threads = await run(["thread", "list", "--json"], env, hook);
      expect(threads.code).not.toBe(0);
    },
    60_000,
  );
});

test("old spellings still work and print nothing extra on stdout", async () => {
  const f = await daemonFixture();
  cleanups.push(() => f.daemon.close());
  const home = join(f.h.home, "daemon");
  const user = await mkdtemp(join(tmpdir(), "ace-cli-machine-user-"));
  cleanups.push(() => rm(user, { recursive: true, force: true }));
  const env = { HOME: user, USERPROFILE: user, ACE_THREAD_ID: undefined };

  const preview = await invoke(home, ["clean", "--dry-run", "--logs", "--json"], "", env);
  expect(preview.code, preview.stderr).toBe(0);
  expect(() => cliOutputs["storage.plan"].parse(JSON.parse(preview.stdout))).not.toThrow();

  const compact = await invoke(home, ["clean", "--compact", "--json"], "", env);
  expect(compact.code, compact.stderr).toBe(0);
  expect(() => cliOutputs["storage.compact"].parse(JSON.parse(compact.stdout))).not.toThrow();

  const token = await invoke(home, ["token"], "", env);
  expect(token.code, token.stderr).toBe(0);
  expect(token.stdout).toBe(`${(await readFile(join(home, "daemon-token"), "utf8")).trim()}\n`);

  const features = await invoke(home, ["features", "on", "marketplace"], "", env);
  expect(features.code, features.stderr).toBe(0);
  expect(features.stdout).toBe("The marketplace is turned on.\n");

  const path = join(user, "support.tar.gz");
  const bundle = await invoke(home, ["support-bundle", path], "", env);
  expect(bundle.code, bundle.stderr).toBe(0);
  expect(bundle.stdout).toBe(`Support bundle: ${path}\n`);
  const again = await invoke(home, ["support-bundle", path], "", env);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("already exists");
}, 60_000);
