import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("`ace start` runs the daemon without loading the other commands' code", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-start-imports-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const loaded = join(root, "loaded");
  const hook = join(root, "hook.mjs");
  await writeFile(loaded, "");
  await writeFile(
    hook,
    `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) { appendFileSync(${JSON.stringify(loaded)}, url + "\\n"); return next(url, context); } });
`,
  );
  const home = join(root, "home");
  const child = spawn(
    process.execPath,
    ["--import", hook, fileURLToPath(new URL("../cli.ts", import.meta.url)), "start", "--json"],
    {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        ACE_HOME: home,
        ACE_WORKSPACE_ROOT: home,
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        ACE_MODEL_INSTANCES: "[]",
        ACE_HISTORY_INSTANCES: "[]",
        ACE_RELAY_URL: undefined,
        PATH: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('"running":true')) resolve();
    });
    void exited.then(() => reject(new Error(`Daemon exited: ${stderr}`)));
  });
  const urls = (await readFile(loaded, "utf8")).split("\n");
  const cli = (name: string) => urls.some((url) => url.endsWith(`/apps/daemon/src/cli/${name}`));
  expect(cli("runtime.ts")).toBe(true);
  expect(["threads.ts", "sim.ts", "projects.ts", "tasks.ts", "cloud.ts"].filter(cli)).toEqual([]);
}, 60_000);
