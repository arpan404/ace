import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { Command, AgentControlResult, ThreadId } from "@ace/protocol";
import { cliDaemon } from "./cli-test-support.ts";

/** Releases a root queue held after a stop, if the stop held it, as the person would. */
async function resumeQueue(f: Awaited<ReturnType<typeof cliDaemon>>) {
  if (!f.engine.queue(f.caller.threadId).paused) return;
  expect(
    f.controls.delegations.command("resume-queue", {
      type: "queue.resume",
      threadId: f.caller.threadId,
      expectedRevision: f.engine.queue(f.caller.threadId).revision,
    }).ok,
  ).toBe(true);
  await f.engine.flush();
}

// OpenCode's build/plan agents follow the user's own permission rules, so an OpenCode
// root cannot vouch for another provider's child (ADR 0013); it is covered as a child.
for (const parent of ["claude", "codex"] as const)
  for (const provider of ["opencode", "claude", "codex"] as const) {
    if (parent === provider) continue;
    test(`${parent} can wait for ${provider}'s result through MCP after stopping and restarting the root`, async () => {
      const f = await cliDaemon(parent);
      const recorded = z
        .object({ actions: z.array(z.record(z.string(), z.unknown())).length(2) })
        .parse(
          JSON.parse(
            await readFile(
              new URL("./__fixtures__/owner-delegation-failure.json", import.meta.url),
              "utf8",
            ),
          ),
        );
      const action = (index: number) =>
        Command.shape.payload.parse({ ...recorded.actions[index], threadId: f.caller.threadId });
      expect(f.controls.delegations.command("stop-parent", action(0)).ok).toBe(true);
      await f.engine.flush();
      expect(f.controls.delegations.command("resume-person", action(1)).ok).toBe(true);
      await f.engine.flush();
      await resumeQueue(f);
      await f.settled();
      const args = {
        tasks: [{ requestId: "after-stop", provider, task: "Hello", role: "greet-after-stop" }],
        waitSeconds: 600,
      };
      const result = await f.call("delegate", args);
      expect(result.isError).not.toBe(true);
      const accepted = AgentControlResult.parse(result.structuredContent);
      const data = z
        .object({
          threadIds: z.tuple([ThreadId]),
          wait: z.object({
            status: z.literal("ready"),
            threads: z.tuple([z.object({ state: z.literal("done"), result: z.string() })]),
          }),
        })
        .parse(accepted.data);
      expect(data.wait.threads[0].result).toContain(
        `${provider === "opencode" ? "OpenCode" : provider === "claude" ? "Claude" : "Codex"} delegated result`,
      );
      expect(f.daemon.store.getThread(data.threadIds[0])?.provider).toBe(provider);
      expect(f.daemon.store.getThread(f.caller.threadId)?.status.state).toBe("done");
      expect((await f.call("delegate", args)).structuredContent).toEqual(result.structuredContent);
      expect(f.daemon.store.listThreads()).toHaveLength(2);
    });
  }

const task = (requestId: string) => ({
  requestId,
  provider: "claude",
  role: `say-hello-${requestId}`,
  task: "Hello",
});
const one = (requestId: string, overrides: Record<string, unknown> = {}) => ({
  tasks: [{ ...task(requestId), ...overrides }],
});
test("single and batch delegation disclose actionable failures and keep diagnostic detail out of MCP and notices", async () => {
  const f = await cliDaemon("codex");
  for (const args of [
    one("disabled-single"),
    { tasks: [task("disabled-batch-a"), task("disabled-batch-b")] },
  ]) {
    await f.daemon.settings.set(
      "providers.configuration",
      [{ provider: "claude", enabled: false }],
      { kind: "global" },
    );
    const result = await f.call("delegate", args);
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"provider_disabled"') }],
    });
  }
  await f.daemon.settings.set("providers.configuration", [], { kind: "global" });
  expect(
    await f.call("delegate", one("provider_unavailable", { provider: "antigravity" })),
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('"code":"provider_unavailable"') }],
  });
  const path = f.daemon.store.getWorkspacePath(f.workspaceId);
  if (!path) throw new Error("Missing sandbox workspace");
  await rename(path, `${path}-moved`);
  try {
    expect(
      await f.call("delegate", one("missing-workspace", { role: "probe-missing-workspace" })),
    ).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"workspace_unavailable"') }],
    });
  } finally {
    await rename(`${path}-moved`, path);
  }
  await f.daemon.models.invalidate({ provider: "claude" });
  const result = await f.call(
    "delegate",
    one("missing-model", { role: "probe-missing-model", model: "private-model-evidence" }),
  );
  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('"code":"model_unavailable"') }],
  });
  expect(JSON.stringify(result)).not.toContain("private-model-evidence");
  const notices = f.daemon.store
    .readItemPage(f.caller.threadId, f.daemon.store.headSeq() + 1, 100)
    .items.filter((item) => item.type === "notice");
  expect(notices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "provider_disabled",
        text: expect.stringContaining("only the person can enable"),
      }),
      expect.objectContaining({ code: "provider_unavailable" }),
      expect.objectContaining({
        code: "model_unavailable",
        text: expect.stringContaining("Call models"),
      }),
    ]),
  );
  expect(JSON.stringify(notices)).not.toContain("private-model-evidence");
  expect(f.daemon.store.listThreads()).toHaveLength(1);
  f.controls.delegations.close();
  expect(
    await f.call("delegate", one("closed-admission", { role: "probe-closed-admission" })),
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('"code":"admission_closed"') }],
  });
  await f.daemon.close();
  const logs = await readFile(join(f.home, "daemon", "logs", "ace.jsonl"), "utf8");
  expect(logs).toContain("private-model-evidence");
});

test("one batch delegation awaits every child on a restarted OpenCode root and retries create nothing", async () => {
  const f = await cliDaemon();
  expect(
    f.controls.delegations.command("stop", {
      type: "thread.interrupt",
      threadId: f.caller.threadId,
      cascade: true,
    }).ok,
  ).toBe(true);
  await f.engine.flush();
  expect(
    f.controls.delegations.command("resume", {
      type: "thread.send",
      threadId: f.caller.threadId,
      input: [{ type: "text", text: "Hello" }],
    }).ok,
  ).toBe(true);
  await f.engine.flush();
  await resumeQueue(f);
  await f.settled();
  // Children stay on OpenCode: its root can only vouch for its own exact policy (ADR 0013).
  const batch = {
    tasks: ["first", "second"].map((requestId) => ({
      requestId,
      provider: "opencode",
      task: "Hello",
      role: `greet-${requestId}`,
    })),
  };
  const result = AgentControlResult.parse(
    (await f.call("delegate", { ...batch, waitSeconds: 60 })).structuredContent,
  );
  const data = z
    .object({ threadIds: z.array(ThreadId).length(2), wait: z.unknown() })
    .parse(result.data);
  expect(data.wait).toMatchObject({
    status: "ready",
    threads: [
      { threadId: data.threadIds[0], state: "done", result: "OpenCode delegated result" },
      { threadId: data.threadIds[1], state: "done", result: "OpenCode delegated result" },
    ],
  });
  const waited = AgentControlResult.parse(
    (await f.call("wait", { threadIds: data.threadIds, mode: "any" })).structuredContent,
  );
  expect(waited.data).toMatchObject({ status: "ready" });
  const retried = AgentControlResult.parse((await f.call("delegate", batch)).structuredContent);
  // The retry names the same children and reports neither as waiting for a run slot.
  expect(retried.data).toEqual({
    threadIds: data.threadIds,
    launches: data.threadIds.map((threadId) => ({ threadId, queued: false })),
  });
  expect(f.daemon.store.listThreads()).toHaveLength(3);
});

test("single and batch delegation refuse an access mode the target lacks, per task, with its supported list", async () => {
  const f = await cliDaemon("codex");
  const unsupported = { ...task("opencode-review"), provider: "opencode", access: "auto-review" };
  for (const args of [{ tasks: [unsupported] }, { tasks: [unsupported, task("never-reached")] }]) {
    const result = await f.call("delegate", args);
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"access_unavailable"') }],
    });
    expect(JSON.stringify(result)).toContain("opencode supports");
  }
  expect(f.daemon.store.listThreads()).toHaveLength(1);
});
