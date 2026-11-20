import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { AgentCatalog, AgentRegistry, type LaunchPlan } from "@ace/agent-registry";
import { ThreadId, type AcpIdentity } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { genericQuirks, openAcpSession } from "./index.ts";

/*
 * The whole path a thread takes after its agent updated itself (ADR 0044 amendment): the
 * approved launcher changes on disk, the launch is refused until the person approves, and the
 * thread's same identity then resumes its saved session. A process test because the agent is a
 * real child process launched from what the registry approved.
 */

const server = fileURLToPath(new URL("./testing/negotiation-server.ts", import.meta.url));
const identity: AcpIdentity = {
  acpAgentId: "local:synthetic",
  installationId: "synthetic-1",
  instanceId: "synthetic-1:default",
};

async function session(plan: LaunchPlan, resume?: { nativeSessionId: string }) {
  const context: SessionContext = {
    threadId: ThreadId.parse("thread-kept"),
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
    ...(resume ? { resume } : {}),
  };
  return openAcpSession(context, genericQuirks, {
    command: plan.command,
    args: [...plan.args],
    env: { ...plan.env },
    version: plan.version,
  });
}

test("after the person approves an agent's update, the same thread identity resumes its session", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-acp-update-")));
  const catalog = await AgentCatalog.open({
    cache: { load: async () => undefined, save: async () => {} },
    target: "linux-x86_64",
    now: () => 1,
    fetch: async () => {
      throw new Error("No network expected");
    },
  });
  const registry = await AgentRegistry.open({
    catalog,
    storage: { load: async () => undefined, save: async () => {} },
    root,
    target: "linux-x86_64",
    env: {},
    now: () => 2,
  });
  try {
    const marker = join(root, "launches");
    const launcher = join(root, "synthetic-agent");
    const script = (release: string) =>
      `#!/bin/sh\nif [ "$1" = --version ]; then echo ${release}; exit 0; fi\necho run >> '${marker}'\nexec '${process.execPath}' '${server}'\n`;
    await writeFile(launcher, script("1.0.0"));
    await chmod(launcher, 0o700);
    await registry.bind({ ...identity, version: "1.0.0", command: launcher, args: [] });
    const env = { ACE_SYNTHETIC_ACP: JSON.stringify({ load: true }) };

    const first = await session(await registry.resolve(identity, env));
    const nativeSessionId = first.nativeSessionId;
    await first.close("user");
    expect(nativeSessionId).toBeTruthy();
    if (!nativeSessionId) throw new Error("No session id");

    // The agent updates itself: its launcher changes on disk.
    await writeFile(launcher, script("1.1.0"));
    await expect(registry.resolve(identity, env)).rejects.toThrow("Approve the update");
    // Refused before anything ran: one launch so far, the approved one.
    expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);

    const reply = await registry.handle({
      type: "registry.list",
      requestId: "list",
      offset: 0,
      limit: 50,
    });
    const update =
      reply.result.ok && "agents" in reply.result ? reply.result.updates?.[0] : undefined;
    if (!update) throw new Error("No update listed");
    const approved = await registry.handle({
      type: "registry.approve-update",
      requestId: "approve",
      ...identity,
      executableDigest: update.executableDigest,
      previousExecutableDigest: update.previousExecutableDigest,
      generation: update.generation,
    });
    // ace read the version from the approved launcher itself, without starting a session.
    expect(approved.result).toMatchObject({ ok: true, installation: { version: "1.1.0" } });
    expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);

    const plan = await registry.resolve(identity, env);
    expect(plan.identity).toEqual(identity);
    const resumed = await session(plan, { nativeSessionId });
    try {
      expect(resumed.nativeSessionId).toBe(nativeSessionId);
    } finally {
      await resumed.close("user");
    }
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
