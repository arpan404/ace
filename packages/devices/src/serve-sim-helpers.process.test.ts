import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { expect, onTestFinished, test } from "vitest";
import { replaceOutdatedHelper } from "./serve-sim-helpers.ts";
import { pinnedServeSim } from "./serve-sim-version.ts";

const udid = "D8ABBF92-C22F-4435-8D35-473FC8E315F5";
const runtime = {
  spawn: spawnRawSupervised,
  after(ms: number, run: () => void) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * A serve-sim helper process running the script at `script` under `home`, and a serve-sim CLI
 * that lists it for `udid` and, asked to kill it, stops it as serve-sim does.
 */
async function helperAt(script: string) {
  const home = await mkdtemp(join(tmpdir(), "ace-serve-sim-helpers-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const path = join(home, script);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "setInterval(() => {}, 1000);\n");
  const helper = spawn(process.execPath, [path, udid, "--port", "3100"], { stdio: "ignore" });
  onTestFinished(() => void helper.kill("SIGKILL"));
  const exited = new Promise<void>((resolve) => helper.once("exit", () => resolve()));
  const pid = helper.pid ?? 0;
  const cli = join(home, "serve-sim");
  await writeFile(
    cli,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "-l") console.log(JSON.stringify({ running: true, device: ${JSON.stringify(udid)}, pid: ${pid}, port: 3100 }));
if (args[0] === "-k") process.kill(${pid}, "SIGTERM");
`,
  );
  await chmod(cli, 0o700);
  const replace = () =>
    replaceOutdatedHelper({
      command: cli,
      args: [],
      version: pinnedServeSim,
      udid,
      env: process.env,
      runtime,
    });
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return { replace, exited, alive };
}

test("a helper an older ace serve-sim left streaming the simulator is stopped", async () => {
  const helper = await helperAt("tools/serve-sim-0.1.48/dist/serve-sim.js");
  await helper.replace();
  await helper.exited;
  expect(helper.alive()).toBe(false);
});

test.each([
  ["the person's own serve-sim", "node_modules/serve-sim/dist/serve-sim.js"],
  ["ace's current serve-sim", `tools/serve-sim-${pinnedServeSim}/dist/serve-sim.js`],
])("a helper started by %s keeps running", async (_, script) => {
  const helper = await helperAt(script);
  await helper.replace();
  expect(helper.alive()).toBe(true);
});
