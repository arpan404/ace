import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "@ace/protocol/cli-output";
import { afterEach, describe, expect, test } from "vitest";

/*
 * The real CLI against an empty temp home with no daemon (ADR 0176 §10, §12.5): in an agent's
 * shell it refuses what is the person's before it reaches for a daemon (exit 2, never the 4 of
 * "ace isn't running"), and off a terminal nobody can answer a request.
 */
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function home(): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), "ace-cli-agent-shell-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { HOME: root, USERPROFILE: root, ACE_HOME: join(root, "ace") };
}

function run(env: Record<string, string>, args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ACE_THREAD_ID: undefined, ACE_NO_INPUT: undefined, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => (stdout += bytes.toString()));
  child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
  child.stdin.end();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const theirs = [
  ["request", "allow", "int_123456"],
  ["request", "deny", "int_123456"],
  ["request", "answer", "int_123456", "yes"],
  ["thread", "approve", "t_123456"],
  ["config", "set", "logs.maxBytes", "10MB"],
  ["config", "unset", "logs.maxBytes"],
  ["feature", "on", "marketplace"],
  ["spade", "on"],
];

describe.each([
  ["ACE_THREAD_ID", { ACE_THREAD_ID: "t_agent1" }],
  ["ACE_NO_INPUT", { ACE_NO_INPUT: "1" }],
])("an agent's shell (%s)", (_name, agent) => {
  test.each(theirs.map((words) => [words.join(" "), words] as const))(
    "can't ace %s: it is the person's",
    async (_line, words) => {
      const env = { ...(await home()), ...agent };
      const human = await run(env, words);
      expect(human.code).toBe(2);
      expect(human.stderr).toContain("is yours to do, not an agent's");
      const json = await run(env, [...words, "--json", "--yes"]);
      expect(json.code).toBe(2);
      expect(CliError.parse(JSON.parse(json.stdout))).toMatchObject({
        status: "needs-human",
        code: "person_only",
      });
    },
  );

  test.each([
    ["market", "install", "suit/dusk-harbor", "--yes"],
    ["market", "withdraw", "suit/dusk-harbor@1.0.0", "--reason", "Broken"],
    ["market", "source", "add", "https://example.com/market"],
    ["market", "remove", "suit/dusk-harbor"],
  ])("can't ace %s %s without a thread to ask in either", async (...words) => {
    const env = { ...(await home()), ACE_NO_INPUT: "1" };
    const output = await run(env, [...words, "--json"]);
    expect(output.code).toBe(2);
    expect(CliError.parse(JSON.parse(output.stdout)).code).toBe("person_only");
  });
});

test("an agent's shell may still read: ace market search goes on to the daemon", async () => {
  const env = { ...(await home()), ACE_NO_INPUT: "1" };
  const output = await run(env, ["market", "search", "dusk", "--json"]);
  // No daemon here: it got past the agent check and found ace down.
  expect(CliError.parse(JSON.parse(output.stdout)).code).toBe("daemon_down");
});

test.each([
  ["request", "allow", "int_123456"],
  ["request", "deny", "int_123456"],
  ["request", "answer", "int_123456", "yes"],
])(
  "a person's CLI off a terminal can't ace %s %s: nobody is there to confirm",
  async (...words) => {
    const output = await run(await home(), [...words, "--json"]);
    expect(output.code).toBe(2);
    expect(CliError.parse(JSON.parse(output.stdout))).toMatchObject({
      status: "needs-human",
      code: "confirm",
    });
  },
);

test("ace help agents says agents never answer requests", async () => {
  const output = await run(await home(), ["help", "agents"]);
  expect(output.code).toBe(0);
  expect(output.stdout).toContain("Agents never answer requests");
});

test("with ace down, Ask me before agents publish isn't changed behind the daemon's back", async () => {
  const env = await home();
  const guarded = await run(env, [
    "config",
    "set",
    "market.askBeforeAgentPublish",
    "off",
    "--json",
  ]);
  expect(guarded.code).toBe(2);
  expect(CliError.parse(JSON.parse(guarded.stdout)).code).toBe("reauth");
  const read = await run(env, ["config", "get", "market.askBeforeAgentPublish", "--json"]);
  expect(read.stdout).not.toContain('"value":true');
  // Other settings still change offline, as before.
  const other = await run(env, ["config", "set", "logs.maxBytes", "10MB", "--json"]);
  expect(other.code, other.stderr).toBe(0);
});
