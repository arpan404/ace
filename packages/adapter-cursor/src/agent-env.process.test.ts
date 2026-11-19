import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createCursorAdapter } from "./index.ts";

// Real edges: the SDK host process ace starts for the session, and a shell command that host
// spawns the way Cursor SDK 1.0.35's local shell does (`{ ...process.env, ...sdkVariables }`).

// A supported SDK installation, resolved without touching the real one.
const discovery = {
  resolve: (id: string) =>
    id === "@cursor/sdk" ? "/sdk/dist/esm/index.js" : "/helper/package.json",
  read: async (path: string) =>
    path === "/sdk/package.json"
      ? '{"name":"@cursor/sdk","version":"1.0.35"}'
      : path === "/helper/package.json"
        ? '{"name":"@cursor/sdk-darwin-arm64","version":"1.0.35"}'
        : Promise.reject(new Error("missing")),
  executable: async () => {},
  platform: "darwin" as const,
  arch: "arm64",
  nodeVersion: "26.0.0",
};

/** A host that, on open, runs one shell command inheriting its own environment. */
const host = (file: string) => `
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const script = "require('node:fs').writeFileSync(" + JSON.stringify(${JSON.stringify(file)}) + ", JSON.stringify(process.env))";
createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.method === 'open') {
    spawnSync(process.execPath, ['-e', script], { env: { ...process.env, CURSOR_AGENT: '1' } });
    out({ id: input.id, result: { agentId: 'synthetic-agent' } });
  } else out({ id: input.id, result: {} });
});
`;

test("a Cursor session's SDK host and the shell commands it runs see the thread's variables", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-agent-env-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const instanceHome = join(root, "instance");
  await mkdir(join(instanceHome, "user"), { recursive: true });
  const file = join(root, "shell-env.json");
  const entry = join(root, "host.mjs");
  await writeFile(entry, host(file));
  const adapter = createCursorAdapter({
    instance: { id: "agent-env", homeDir: instanceHome },
    userHome: join(root, "real"),
    userEnv: {},
    discovery,
    entry,
  });
  onTestFinished(() => adapter.close());

  const session = await adapter.openSession({
    threadId: ThreadId.parse("thread-cursor"),
    cwd: root,
    env: { HOME: join(instanceHome, "user") },
    agentEnv: { ACE_THREAD_ID: "thread-cursor", ACE_NO_INPUT: "1", ACE_HOME: "/person/.ace" },
    signal: new AbortController().signal,
    onFrame: () => {},
    onExit: () => {},
  });

  const shell: unknown = JSON.parse(await readFile(file, "utf8"));
  expect(shell).toMatchObject({
    ACE_THREAD_ID: "thread-cursor",
    ACE_NO_INPUT: "1",
    ACE_HOME: "/person/.ace",
    HOME: join(instanceHome, "user"),
  });
  await session.close("shutdown");
});
