import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { Command, AgentControlResult, ThreadId } from "@ace/protocol";
import { cliDaemon } from "./cli-test-support.ts";

for (const parent of ["opencode", "claude", "codex"] as const)
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

test("all creation tools disclose actionable failures and keep diagnostic detail out of MCP and notices", async () => {
  const f = await cliDaemon();
  for (const name of ["delegate_task", "ace_spawn_agent", "ace_thread_create"]) {
    const args =
      name === "ace_thread_create"
        ? { requestId: `disabled-${name}`, provider: "claude", title: "Hello" }
        : name === "ace_spawn_agent"
          ? { provider: "claude", name: "Hello", task: "Hello" }
          : { requestId: `disabled-${name}`, provider: "claude", role: "Hello", task: "Hello" };
    await f.daemon.settings.set(
      "providers.configuration",
      [{ provider: "claude", enabled: false }],
      { kind: "global" },
    );
    const result = await f.call(name, args);
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
    const result = await f.call("ace_thread_create", {
      requestId: code,
      provider,
      accountId,
      title: "Hello",
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
      await f.call("ace_thread_create", {
        requestId: "missing-workspace",
        provider: "claude",
        title: "Hello",
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"code":"workspace_unavailable"') }],
    });
  } finally {
    await rename(`${path}-moved`, path);
  }
  await f.daemon.models.invalidate({ provider: "claude" });
  const result = await f.call("ace_thread_create", {
    requestId: "missing-model",
    provider: "claude",
    model: "private-model-evidence",
    title: "Hello",
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
        detail: expect.stringContaining("Enable"),
      }),
      expect.objectContaining({ code: "provider_unavailable" }),
      expect.objectContaining({ code: "account_unavailable" }),
      expect.objectContaining({
        code: "model_unavailable",
        detail: expect.stringContaining("Refresh"),
      }),
    ]),
  );
  expect(JSON.stringify(notices)).not.toMatch(/private-model-evidence|private-missing-account/);
  expect(f.daemon.store.listThreads()).toHaveLength(1);
  f.controls.delegations.close();
  expect(
    await f.call("ace_thread_create", {
      requestId: "closed-admission",
      provider: "claude",
      title: "Hello",
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

test("legacy spawn and separate create/launch/wait tools work on a restarted OpenCode root", async () => {
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
  await f.settled();
  for (const provider of ["claude", "opencode"] as const) {
    const spawned = await f.call("ace_spawn_agent", { provider, task: "Hello", name: "greeter" });
    const accepted = z
      .object({ intentId: ThreadId, accepted: z.literal(true) })
      .parse(spawned.structuredContent);
    const outcome = AgentControlResult.parse(
      (await f.call("ace_thread_wait", { threadId: accepted.intentId })).structuredContent,
    );
    expect(outcome.data).toMatchObject({
      outcome: "completed",
      result: expect.stringContaining("delegated result"),
    });
  }
  const prepared = AgentControlResult.parse(
    (
      await f.call("ace_thread_create", {
        requestId: "created",
        provider: "claude",
        title: "greeter",
      })
    ).structuredContent,
  );
  const childId = f.child(prepared.data);
  expect(f.daemon.store.getThread(childId)?.status.state).toBe("new");
  expect(
    AgentControlResult.parse(
      (await f.call("ace_thread_launch", { requestId: "launch", threadId: childId, text: "Hello" }))
        .structuredContent,
    ).ok,
  ).toBe(true);
  const result = AgentControlResult.parse(
    (await f.call("ace_thread_wait", { threadId: childId })).structuredContent,
  );
  expect(result.data).toMatchObject({ outcome: "completed", result: "Claude delegated result" });
});
