import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { AgentId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { builtinSkillsDirectory } from "@ace/plugins";
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

/** What each fake Claude process read through the plugin directories it was launched with. */
const PluginSkills = z.object({
  pluginSkills: z.array(z.object({ directory: z.string(), text: z.string() })),
});
const readThrough = (frames: Frame[]) =>
  frames.flatMap((frame) => {
    const parsed = PluginSkills.safeParse(frame.data);
    return parsed.success ? [parsed.data.pluginSkills] : [];
  })[0];

it("Claude sessions read ace's skills from one copy, and shutdown removes it", async () => {
  const f = await setup("claude");
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "ace-claude-skills-")));
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
    createClaudeAdapter({
      executable: cli,
      env: { ACE_FAKE_CLAUDE_READ_SKILL: "review-changes" },
    }),
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
    const frames: Frame[] = [];
    const session = await adapter.openSession({
      threadId: f.thread.id,
      cwd: f.home,
      signal: new AbortController().signal,
      aceMcp: { url: f.mcp.url, bearer: lease.bearer, end: lease.end },
      onFrame: (frame) => frames.push(frame),
      onExit() {},
    });
    cleanups.push(() => session.close("shutdown"));
    return { session, frames };
  };
  const first = await open("first");
  const second = await open("second");
  const shipped = await readFile(
    join(builtinSkillsDirectory(), "review-changes", "SKILL.md"),
    "utf8",
  );
  const [one, two] = [readThrough(first.frames), readThrough(second.frames)];
  expect(one).toEqual([{ directory: expect.any(String), text: shipped }]);
  expect(two).toEqual(one);
  const [root] = await roots(dataDir);
  expect(one?.[0]?.directory.startsWith(join(dataDir, builtinSkillSessionsDirectory, root ?? "-"))).toBe(
    true,
  );

  await first.session.close("shutdown");
  await second.session.close("shutdown");
  await resources.close();
  expect(await roots(dataDir)).toEqual([]);
});

it("Claude sessions opening together at a copy's last free launch each get a launch, and replacing it stops none", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-claude-skills-"));
  removals.push(dataDir);
  const skills = sharedBuiltinSkills("claude", dataDir);
  // One real provider process, recorded 63 times: the copy has one launch left.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    detached: true,
    stdio: "ignore",
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const pid = child.pid ?? 0;
  const filler = await skills.acquire();
  for (let launch = 0; launch < 63; launch++) {
    filler.lease.preparing();
    filler.lease.spawned(pid);
  }
  await filler.release();

  // Three sessions acquire before any of them reaches its spawn (each awaits a version probe).
  const opening = await Promise.all([skills.acquire(), skills.acquire(), skills.acquire()]);
  for (const session of opening) {
    expect(() => {
      session.lease.preparing();
      session.lease.spawned(pid);
    }).not.toThrow();
  }
  expect(new Set(opening.map((session) => session.directories[0])).size).toBe(2);
  for (const session of opening) await session.release();
  await skills.close();
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
