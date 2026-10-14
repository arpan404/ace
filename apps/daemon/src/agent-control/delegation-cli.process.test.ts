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
      const stopped = await f.call("delegate_task", {
        requestId: "stopped",
        provider,
        task: "Hello",
        role: "greeter",
        wait: true,
      });
      expect(stopped).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('"code":"delegation_cancelled"') }],
      });
      expect(f.daemon.store.listThreads()).toHaveLength(1);
      expect(f.controls.delegations.command("resume-person", action(1)).ok).toBe(true);
      await f.engine.flush();
      await resumeQueue(f);
      await f.settled();
      const args = {
        requestId: "after-stop",
        provider,
        task: "Hello",
        role: "greeter",
        wait: true,
      };
      const result = await f.call("delegate_task", args);
      expect(result.isError).not.toBe(true);
      const accepted = AgentControlResult.parse(result.structuredContent);
      const child = z
        .object({
          threadId: ThreadId,
          outcome: z.object({ outcome: z.literal("completed"), result: z.string() }),
        })
        .parse(accepted.data);
      expect(child.outcome.result).toContain(
        `${provider === "opencode" ? "OpenCode" : provider === "claude" ? "Claude" : "Codex"} delegated result`,
      );
      expect(f.daemon.store.getThread(child.threadId)?.provider).toBe(provider);
      expect(f.daemon.store.getThread(f.caller.threadId)?.status.state).toBe("done");
      expect((await f.call("delegate_task", args)).structuredContent).toEqual(
        result.structuredContent,
      );
      expect(f.daemon.store.listThreads()).toHaveLength(2);
    });
  }

const task = (requestId: string) => ({
  requestId,
  provider: "claude",
  role: "Hello",
  task: "Hello",
});
test("single and batch delegation disclose actionable failures and keep diagnostic detail out of MCP and notices", async () => {
  const f = await cliDaemon("codex");
  for (const args of [task("disabled-single"), { tasks: [task("disabled-batch")] }]) {
    await f.daemon.settings.set(
      "providers.configuration",
      [{ provider: "claude", enabled: false }],
      { kind: "global" },
    );
    const result = await f.call("delegate_task", args);
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"provider_disabled"') }],
    });
  }
  await f.daemon.settings.set("providers.configuration", [], { kind: "global" });
  for (const [provider, accountId, code] of [
    ["antigravity", undefined, "provider_unavailable"],
    ["claude", "private-missing-account", "account_unavailable"],
  ] as const) {
    const result = await f.call("delegate_task", {
      role: "Hello",
      task: "Hello",
      requestId: code,
      provider,
      accountId,
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining(`"code":"${code}"`) }],
    });
    expect(JSON.stringify(result)).not.toContain("private-missing-account");
  }
  const path = f.daemon.store.getWorkspacePath(f.workspaceId);
  if (!path) throw new Error("Missing sandbox workspace");
  await rename(path, `${path}-moved`);
  try {
    expect(
      await f.call("delegate_task", {
        role: "Hello",
        task: "Hello",
        requestId: "missing-workspace",
        provider: "claude",
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"workspace_unavailable"') }],
    });
  } finally {
    await rename(`${path}-moved`, path);
  }
  await f.daemon.models.invalidate({ provider: "claude" });
  const result = await f.call("delegate_task", {
    role: "Hello",
    task: "Hello",
    requestId: "missing-model",
    provider: "claude",
    model: "private-model-evidence",
  });
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
        text: expect.stringContaining("Enable"),
      }),
      expect.objectContaining({ code: "provider_unavailable" }),
      expect.objectContaining({ code: "account_unavailable" }),
      expect.objectContaining({
        code: "model_unavailable",
        text: expect.stringContaining("Refresh"),
      }),
    ]),
  );
  expect(JSON.stringify(notices)).not.toMatch(/private-model-evidence|private-missing-account/);
  expect(f.daemon.store.listThreads()).toHaveLength(1);
  f.controls.delegations.close();
  expect(
    await f.call("delegate_task", {
      role: "Hello",
      task: "Hello",
      requestId: "closed-admission",
      provider: "claude",
    }),
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('"code":"admission_closed"') }],
  });
  await f.daemon.close();
  const logs = await readFile(join(f.home, "daemon", "logs", "ace.jsonl"), "utf8");
  expect(logs).toContain("private-model-evidence");
  expect(logs).toContain("private-missing-account");
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
      role: "greeter",
    })),
    await: "all",
    timeoutSeconds: 60,
  };
  const result = AgentControlResult.parse((await f.call("delegate_task", batch)).structuredContent);
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
    (await f.call("ace_wait", { threadIds: data.threadIds, mode: "any" })).structuredContent,
  );
  expect(waited.data).toMatchObject({ status: "ready" });
  const retried = AgentControlResult.parse(
    (await f.call("delegate_task", { ...batch, await: "none" })).structuredContent,
  );
  expect(retried.data).toEqual({ threadIds: data.threadIds });
  expect(f.daemon.store.listThreads()).toHaveLength(3);
});

test("single and batch delegation refuse an access mode the target lacks, per task, with its supported list", async () => {
  const f = await cliDaemon("codex");
  const unsupported = { ...task("opencode-review"), provider: "opencode", access: "auto-review" };
  for (const args of [unsupported, { tasks: [unsupported, task("never-reached")] }]) {
    const result = await f.call("delegate_task", args);
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"access_unavailable"') }],
    });
    expect(JSON.stringify(result)).toContain("opencode supports");
  }
  expect(f.daemon.store.listThreads()).toHaveLength(1);
});
