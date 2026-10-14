import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { AgentId } from "@ace/protocol";
import { createCodexAdapter } from "@ace/adapter-codex";
import type { Frame } from "@ace/engine-api";
import { readConfig } from "./config.ts";
import { builtinSkillSessionsDirectory } from "./builtin-skill-roots.ts";
import { Resources } from "./services/resources.ts";
import { withDaemonMcp } from "./services/provider-mcp.ts";
import { setup, cleanups } from "./browser-mcp-test-support.ts";

const removals: string[] = [];
afterEach(async () => {
  for (const directory of removals.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("Codex sessions with built-in skills share one app-server, and shutdown removes the projection", async () => {
  const f = await setup("codex");
  const dataDir = await mkdtemp(join(tmpdir(), "ace-shared-skills-"));
  removals.push(dataDir);
  const cli = join(dataDir, "fake-codex.mjs");
  await writeFile(
    cli,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("../../../packages/adapter-codex/src/testing/shared-cli.ts", import.meta.url).href)};\n`,
    { mode: 0o700 },
  );
  const resources = new Resources();
  const adapter = withDaemonMcp(
    {
      store: f.store,
      services: {},
      id: () => "unused-wrapper-session",
      config: readConfig({ ACE_HOME: dataDir }, dataDir),
      resources,
    },
    createCodexAdapter({
      cli: { installed: true, path: cli, version: "0.159.1", auth: "unknown", loginHint: "fake" },
      runtime: { stopGraceMs: 0 },
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
    const started = z.object({ result: z.object({ pid: z.number() }) });
    const pid = frames
      .map((frame) => started.safeParse(frame.data))
      .find((parsed) => parsed.success)?.data?.result.pid;
    return { session, pid };
  };
  const first = await open("first");
  const second = await open("second");
  expect(first.pid).toBeDefined();
  expect(second.pid).toBe(first.pid);

  await first.session.close("shutdown");
  await second.session.close("shutdown");
  await resources.close();
  const roots = await readdir(join(dataDir, builtinSkillSessionsDirectory));
  expect(roots.filter((name) => name.startsWith("session-"))).toEqual([]);
});
