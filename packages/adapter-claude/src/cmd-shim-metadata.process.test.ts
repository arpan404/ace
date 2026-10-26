import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeCmdShim } from "@ace/adapter-testkit";
import { discoverClaudeModels } from "./model-discovery.ts";
import { readClaudePlanUsage } from "./usage-read.ts";

/*
 * Claude metadata questions on Windows, against a stand-in CLI installed as a `.cmd` shim.
 * Windows never delivers SIGTERM to the metadata helper, so cancelling relies on its stdin
 * closing; the forced tree stop only follows after a 2 s grace.
 */
const windowsHost = process.platform === "win32";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Records its pid, answers `initialize` and `get_usage`, or never answers when told to hang. */
async function fakeClaude(hang = false) {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-metadata-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "claude.cjs");
  const pids = join(root, "pids");
  await writeFile(
    script,
    `const { createInterface } = require("node:readline");
require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ pid: process.pid }));
const hang = ${hang};
// A hung CLI does not notice its input closing, so only its owner can end it.
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
  const executable = await writeCmdShim(root, "claude", script);
  const ran = async () => JSON.parse(await readFile(pids, "utf8")) as { pid: number };
  return { input: { executable, args: [], cwd: root, env: { USERPROFILE: root } }, ran };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.runIf(windowsHost)(
  "a .cmd-installed Claude login's models and plan limits are read on Windows",
  async () => {
    const claude = await fakeClaude();
    const signal = new AbortController().signal;
    expect(await discoverClaudeModels({ ...claude.input, signal })).toEqual({
      models: [{ value: "opus", displayName: "Opus", description: "" }],
    });
    const { pid } = await claude.ran();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
    expect(await readClaudePlanUsage({ ...claude.input, signal })).toMatchObject({
      event: "claude-usage",
      planType: "max",
      usageWindows: { five_hour: { usedPercent: 41, windowDurationMins: 300 } },
    });
  },
);

test.runIf(windowsHost)(
  "cancelling an unanswered Windows question ends the helper through its input, then its CLI",
  async () => {
    const claude = await fakeClaude(true);
    const controller = new AbortController();
    const asked = discoverClaudeModels({ ...claude.input, signal: controller.signal });
    const outcome = asked.then(
      () => "answered",
      () => "cancelled",
    );
    await vi.waitFor(() => claude.ran(), { timeout: 20_000 });
    const { pid } = await claude.ran();
    const started = performance.now();
    controller.abort();
    expect(await outcome).toBe("cancelled");
    // The helper waits out a 2 s grace before the forced stop; closing stdin ends it first.
    expect(performance.now() - started).toBeLessThan(1_500);
    // The hung CLI ignores its input; the helper's Job Object or tree stop ends it.
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
  },
);
