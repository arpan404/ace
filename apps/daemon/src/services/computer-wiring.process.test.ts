import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { computerPlatform } from "./mcp.ts";
import { windowsComputerClient } from "./screen.ts";

// Stands in for ace-screen-helper-windows --computer: answers each request, and on stdin's end
// either exits on its own (as the helper does after putting the clipboard back) or ignores it.
const helperScript = (stopsOnEnd: boolean) => `
  const rl = require("node:readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const { id } = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id, ok: true, result: { version: 2 } }) + "\\n");
  });
  rl.on("close", () => { ${stopsOnEnd ? "process.exit(0)" : "setInterval(() => {}, 1000)"}; });
`;

function windowsClient(stopsOnEnd: boolean) {
  const started: { args: readonly string[]; child: ChildProcessWithoutNullStreams }[] = [];
  const client = windowsComputerClient("C:\\ace\\ace-screen-helper-windows.exe", "/data", {
    spawnHelper: (_command, args, env) => {
      const child = spawn(process.execPath, ["-e", helperScript(stopsOnEnd), ...args], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      started.push({ args, child });
      return child;
    },
  });
  onTestFinished(() => {
    client.close();
    for (const { child } of started) child.kill();
  });
  return { client, started };
}

const exit = (child: ChildProcessWithoutNullStreams) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

it("the Windows daemon starts the computer-use engine with its data dir", async () => {
  const { client, started } = windowsClient(true);
  await client.request("hello", {});
  expect(started.map((entry) => entry.args)).toEqual([
    ["--computer", "--data-dir", join("/data", "screen")],
  ]);
});

it("a Windows helper that stops when stdin closes is left to exit on its own", async () => {
  const { client, started } = windowsClient(true);
  await client.request("hello", {});
  const [helper] = started;
  if (!helper) throw new Error("No helper started");
  const exited = exit(helper.child);
  client.close();
  expect(await exited).toEqual({ code: 0, signal: null });
});

it("a Windows helper that does not stop after stdin closes is killed after a second", async () => {
  const { client, started } = windowsClient(false);
  await client.request("hello", {});
  const [helper] = started;
  if (!helper) throw new Error("No helper started");
  const exited = exit(helper.child);
  const closedAt = Date.now();
  client.close();
  const result = await exited;
  expect(result.code === 0 && result.signal === null).toBe(false);
  expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900);
});

it("computer-use tools use Windows wording only on Windows", () => {
  expect(computerPlatform("win32")).toBe("windows");
  expect(computerPlatform("darwin")).toBe("macos");
  expect(computerPlatform("linux")).toBe("linux");
});
