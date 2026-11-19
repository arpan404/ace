import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createAcpAdapter, type AdapterOptions } from "./adapter.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";

// Real edges: the ACP agent process ace starts for the session, and a shell command that agent
// runs itself (ace offers ACP agents no client terminal), inheriting the agent's environment.

const fake = fileURLToPath(new URL("./testing/acp-server.ts", import.meta.url));
const variables = { ACE_THREAD_ID: "thread-agy", ACE_NO_INPUT: "1", ACE_HOME: "/person/.ace" };
const launches: [string, AdapterOptions][] = [
  ["its installed command", { command: process.execPath, args: [fake] }],
  [
    "a resolved launch plan",
    {
      resolveLaunch: async () => ({
        identity: { acpAgentId: "antigravity", installationId: "test", instanceId: "test" },
        command: process.execPath,
        args: [fake],
        env: {},
        version: "1.2.1",
      }),
    },
  ],
];

/** The file's text once the agent's command has written it. */
async function written(file: string): Promise<string> {
  for (let tries = 0; ; tries++) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text) return text;
    if (tries > 200) throw new Error("the agent's shell command never ran");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.each(launches)(
  "an Antigravity agent started from %s runs shell commands with the thread's variables",
  async (_launch, options) => {
    const home = await mkdtemp(join(tmpdir(), "ace-acp-agent-env-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const session = await createAcpAdapter(antigravityQuirks, options).openSession({
      threadId: ThreadId.parse("thread-agy"),
      cwd: home,
      env: { HOME: home },
      agentEnv: variables,
      model: "test-model",
      signal: new AbortController().signal,
      onFrame() {},
      onExit() {},
    });
    onTestFinished(() => session.close("user"));
    const file = join(home, "shell-env.json");

    await session.send([{ type: "text", text: `shell-env:${file}` }], "queue");

    const shell: unknown = JSON.parse(await written(file));
    expect(shell).toMatchObject({ ...variables, HOME: home });
  },
);
