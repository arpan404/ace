import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { discoverClaudeModels } from "./model-discovery.ts";
import { readClaudePlanUsage } from "./usage-read.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A stand-in Claude CLI: it records its own pid and its parent's, answers `initialize` with one
 * model and `get_usage` with a plan reading, or never answers when told to hang.
 */
async function fakeClaude(hang = false) {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-metadata-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "claude");
  const pids = join(root, "pids");
  await writeFile(
    executable,
    `#!${process.execPath}
const { createInterface } = require("node:readline");
require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ pid: process.pid, parent: process.ppid }));
const hang = ${hang};
// A hung CLI does not notice its input closing, so it outlives a helper killed outright.
if (hang) setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const data = JSON.parse(line);
  if (data.type !== "control_request" || hang) return;
  const subtype = data.request.subtype;
  const response = subtype === "initialize"
    ? { commands: [], agents: [], models: [{ value: "opus", displayName: "Opus", description: "" }] }
    : subtype === "get_usage"
      ? { subscription_type: "max", rate_limits: { five_hour: { utilization: 41, resets_at: null } } }
      : {};
  console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: data.request_id, response } }));
});
`,
  );
  await chmod(executable, 0o755);
  const ran = async () =>
    JSON.parse(await readFile(pids, "utf8")) as { pid: number; parent: number };
  return { input: { executable, args: [], cwd: root, env: { HOME: root } }, ran };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a Claude login's models and plan limits are read by a helper process, not the caller", async () => {
  const claude = await fakeClaude();
  const signal = new AbortController().signal;
  expect(await discoverClaudeModels({ ...claude.input, signal })).toEqual({
    models: [{ value: "opus", displayName: "Opus", description: "" }],
  });
  // The CLI's parent is the helper: this process never started it, so it never loaded the SDK.
  const { parent } = await claude.ran();
  expect(parent).not.toBe(process.pid);
  expect(alive(parent)).toBe(false);
  expect(await readClaudePlanUsage({ ...claude.input, signal })).toMatchObject({
    event: "claude-usage",
    planType: "max",
    usageWindows: { five_hour: { usedPercent: 41, windowDurationMins: 300 } },
  });
});

test("cancelling a question that the CLI never answers ends the helper and its CLI", async () => {
  const claude = await fakeClaude(true);
  const controller = new AbortController();
  const asked = discoverClaudeModels({ ...claude.input, signal: controller.signal });
  const outcome = asked.then(
    () => "answered",
    () => "cancelled",
  );
  await vi.waitFor(() => claude.ran(), { timeout: 20_000 });
  const { pid, parent } = await claude.ran();
  controller.abort();
  expect(await outcome).toBe("cancelled");
  await vi.waitFor(() => expect([alive(pid), alive(parent)]).toEqual([false, false]), {
    timeout: 10_000,
  });
});

test("a helper killed outright does not leave its Claude CLI running", async () => {
  const claude = await fakeClaude(true);
  const asked = discoverClaudeModels({ ...claude.input, signal: new AbortController().signal });
  const outcome = asked.then(
    () => "answered",
    () => "failed",
  );
  await vi.waitFor(() => claude.ran(), { timeout: 20_000 });
  const { pid, parent } = await claude.ran();
  // As when the daemon's own fatal exit SIGKILLs the helper: no shutdown handler of its runs.
  process.kill(parent, "SIGKILL");
  expect(await outcome).toBe("failed");
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
});
