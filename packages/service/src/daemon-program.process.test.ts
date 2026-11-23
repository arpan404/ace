import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { daemonRuntimeArgs, spawnDaemonRuntime } from "./daemon-program.ts";
import { shippedExecutableName } from "./process-names.ts";

// Real edge: Bun reads `.env` files from the working directory, and treats a first bare word as
// one of its own commands, only when its executable is not named `node`. Only the real runtime
// under the daemon's name shows that.
const onBun = typeof Reflect.get(globalThis, "Bun") === "object";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The running runtime under the daemon's name, and a project folder with a `.env`. */
function namedRuntime(): { named: string; project: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "ace-daemon-program-"));
  roots.push(root);
  const named = join(root, shippedExecutableName("daemon", process.platform));
  try {
    linkSync(process.execPath, named);
  } catch {
    copyFileSync(process.execPath, named);
  }
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "ACE_PORT=not-a-port\nACE_PROBE=from-dotenv\n");
  writeFileSync(join(project, ".env.local"), "ACE_PROBE=from-dotenv-local\n");
  const script = join(root, "probe.mjs");
  writeFileSync(
    script,
    "console.log(JSON.stringify({ port: process.env.ACE_PORT ?? null, probe: process.env.ACE_PROBE ?? null, args: process.argv.slice(2) }));\n",
  );
  return { named, project, script };
}

async function output(command: string, args: string[], cwd: string): Promise<string> {
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? "" } });
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  await once(child, "close");
  return text.trim();
}

test.runIf(onBun)(
  "the daemon under its own name reads no .env from the folder it is started in",
  async () => {
    const { named, project, script } = namedRuntime();
    const seen = JSON.parse(await output(named, daemonRuntimeArgs(script, ["start"]), project));
    expect(seen).toEqual({ port: null, probe: null, args: ["start"] });
  },
);

test.runIf(onBun)("a daemon word is the script's argument, never a command of Bun's", async () => {
  const { named, project, script } = namedRuntime();
  for (const word of ["install", "run", "test"]) {
    const seen = JSON.parse(await output(named, daemonRuntimeArgs(script, [word]), project));
    expect(seen.args).toEqual([word]);
  }
});

test("a daemon launch takes only an absolute script, so Bun never reads it as a command", () => {
  expect(() => daemonRuntimeArgs("ace.mjs", ["start"])).toThrow(/absolute/);
});

test("the daemon starts on the plain runtime when its named one cannot be spawned", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-daemon-fallback-"));
  roots.push(root);
  const missing = join(root, shippedExecutableName("daemon", process.platform));
  const tried: string[] = [];
  const child = spawnDaemonRuntime([missing, process.execPath], (command) => {
    tried.push(command);
    return spawn(command, ["-e", "process.stdout.write('started')"], { stdio: "pipe" });
  });
  let text = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const [code] = await once(child, "close");
  expect(tried).toEqual([missing, process.execPath]);
  expect(code).toBe(0);
  expect(text).toBe("started");
});
