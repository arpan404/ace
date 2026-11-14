import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentId } from "@ace/protocol";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { readConfig } from "./config.ts";
import { builtinSkillSessionsDirectory } from "./builtin-skill-roots.ts";
import { sharedBuiltinSkills } from "./builtin-skill-share.ts";
import { Resources } from "./services/resources.ts";
import { withDaemonMcp } from "./services/provider-mcp.ts";
import { setup, cleanups } from "./browser-mcp-test-support.ts";

// Real edges: the fake Claude CLI runs as a child process, and the projection and its process
// lease live on disk where daemon recovery reads them.
const removals: string[] = [];
afterEach(async () => {
  for (const directory of removals.splice(0)) await rm(directory, { recursive: true, force: true });
});
const roots = async (dataDir: string) =>
  (await readdir(join(dataDir, builtinSkillSessionsDirectory))).filter((name) =>
    name.startsWith("session-"),
  );

it("Claude sessions read ace's skills from one copy, and shutdown removes it", async () => {
  const f = await setup("claude");
  const dataDir = await mkdtemp(join(tmpdir(), "ace-claude-skills-"));
  removals.push(dataDir);
  const cli = join(dataDir, "claude");
  const source = new URL("../../../packages/adapter-claude/src/testing/cli.ts", import.meta.url);
  await writeFile(cli, `#!${process.execPath}\nawait import(${JSON.stringify(source.href)});\n`);
  await chmod(cli, 0o700);
  const resources = new Resources();
  const adapter = withDaemonMcp(
    {
      store: f.store,
      services: {},
      id: () => "unused-wrapper-session",
      config: readConfig({ ACE_HOME: dataDir }, dataDir),
      resources,
    },
    createClaudeAdapter({ executable: cli }),
  );
  const open = async (name: string) => {
    const lease = f.mcp.openSession(
      {
        sessionId: name,
        threadId: f.thread.id,
        agentId: AgentId.parse("root"),
        capabilities: ["agents"],
      },
      new AbortController().signal,
    );
    const session = await adapter.openSession({
      threadId: f.thread.id,
      cwd: f.home,
      signal: new AbortController().signal,
      aceMcp: { url: f.mcp.url, bearer: lease.bearer, end: lease.end },
      onFrame() {},
      onExit() {},
    });
    cleanups.push(() => session.close("shutdown"));
    return session;
  };
  const first = await open("first");
  const second = await open("second");
  expect(await roots(dataDir)).toHaveLength(1);

  await first.close("shutdown");
  await second.close("shutdown");
  await resources.close();
  expect(await roots(dataDir)).toEqual([]);
});

it("a launch that failed before its process started does not block later sessions' launches", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-claude-skills-"));
  removals.push(dataDir);
  const skills = sharedBuiltinSkills("claude", dataDir);
  const failed = await skills.acquire();
  // The spawn threw after the launch was announced: no pid was ever recorded.
  failed.lease.preparing();
  await failed.release();

  const next = await skills.acquire();
  expect(() => next.lease.preparing()).not.toThrow();
  await next.release();
  await skills.close();
});
