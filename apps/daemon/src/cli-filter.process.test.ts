import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";
const identity = z.object({ threadId: ThreadId });

test.each(["subtree", "provider"] as const)(
  "%s kill suppresses asynchronous child result wakes after the coalescing deadline",
  async (scope) => {
    const f = await daemonFixture();
    const home = join(f.h.home, "daemon");
    try {
      const launched = await invoke(home, [
        "run",
        "Working parent",
        "--provider",
        "claude",
        "--project",
        f.workspace,
        "--json",
      ]);
      const parent = identity.parse(JSON.parse(launched.stdout)).threadId;
      const spawned = await invoke(home, [
        "task",
        "spawn",
        "Asynchronous child",
        "--parent",
        parent,
        "--provider",
        scope === "subtree" ? "claude" : "codex",
        "--json",
      ]);
      const child = z.object({ data: identity }).parse(JSON.parse(spawned.stdout)).data.threadId;
      await f.daemon.engine?.flush();
      if (scope === "provider") {
        await f.h.emit(child, {
          type: "turn.started",
          agent: "root",
          trigger: "background_completion",
          nativeTurnId: "unfinished-child",
        });
        await f.daemon.engine?.flush();
      }
      const killed = await invoke(home, [
        "kill-all",
        ...(scope === "subtree" ? ["--thread", parent] : ["--provider", "claude"]),
        "--json",
      ]);
      expect(killed.code, killed.stderr).toBe(0);
      if (scope === "provider") {
        const followup = await invoke(home, [
          "thread",
          "send",
          child,
          "Still selected for work",
          "--json",
        ]);
        expect(followup.code, followup.stderr).toBe(0);
        await f.daemon.engine?.flush();
        await f.h.complete(child, "Unmatched child completed");
      }
      f.h.clock.advance(f.h.clock.now() + f.controls.delegations.policy.coalesceMs + 1000);
      await f.daemon.engine?.flush();
      const waited = await invoke(home, [
        "thread",
        "wait",
        parent,
        "--tree",
        "--timeout",
        "2s",
        "--json",
      ]);
      expect(waited.code, waited.stderr).toBe(1);
      expect(JSON.parse(waited.stdout)).toMatchObject({
        status: "failed",
        tree: expect.arrayContaining([
          expect.objectContaining({
            threadId: parent,
            queue: expect.objectContaining({ pendingCount: 0 }),
          }),
        ]),
      });
      const status = await invoke(home, ["task", "status", child, "--json"]);
      expect(JSON.parse(status.stdout)).toMatchObject(
        scope === "subtree"
          ? { state: "cancelled", outcome: { outcome: "cancelled" } }
          : { state: "result_available", outcome: { outcome: "completed" } },
      );
    } finally {
      await f.daemon.close();
    }
  },
);

test("kill-all cleans idle sessions while preserving completed work with the same provider", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const run = async (prompt: string) => {
      const output = await invoke(home, [
        "run",
        prompt,
        "--provider",
        "claude",
        "--project",
        f.workspace,
        "--json",
      ]);
      expect(output.code, output.stderr).toBe(0);
      return identity.parse(JSON.parse(output.stdout)).threadId;
    };
    const completed = await run("Successful thread A");
    await f.daemon.engine?.flush();
    await f.h.complete(completed, "Successful answer");
    const before = await invoke(home, ["thread", "wait", completed, "--tree", "--json"]);
    expect(before.code, before.stderr).toBe(0);
    const active = await run("Unrelated active work");
    await f.daemon.engine?.flush();
    const kill = await invoke(home, ["kill-all", "--provider", "claude", "--json"]);
    expect(kill.code, kill.stderr).toBe(0);
    expect(JSON.parse(kill.stdout)).toMatchObject({ data: { cancelled: [active] } });
    const after = await invoke(home, ["thread", "wait", completed, "--tree", "--json"]);
    expect(after.code, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ status: "ok", cancelled: [] });
    const interrupted = await invoke(home, ["thread", "wait", active, "--tree", "--json"]);
    expect(interrupted.code, interrupted.stderr).toBe(1);
    expect(JSON.parse(interrupted.stdout)).toMatchObject({ status: "failed", cancelled: [active] });
  } finally {
    await f.daemon.close();
  }
});

test("subtree kill cancels unfinished ancestors without rewriting a completed child's result", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const launched = await invoke(home, [
      "run",
      "Working parent",
      "--provider",
      "claude",
      "--project",
      f.workspace,
      "--json",
    ]);
    const parent = identity.parse(JSON.parse(launched.stdout)).threadId;
    const delegated = await invoke(home, [
      "task",
      "spawn",
      "Finished child",
      "--parent",
      parent,
      "--provider",
      "codex",
      "--json",
    ]);
    const child = z.object({ data: identity }).parse(JSON.parse(delegated.stdout)).data.threadId;
    await f.daemon.engine?.flush();
    const before = await invoke(home, ["task", "status", child, "--json"]);
    expect(JSON.parse(before.stdout)).toMatchObject({
      state: "result_available",
      outcome: { outcome: "completed" },
    });
    const kill = await invoke(home, ["kill-all", "--thread", parent, "--json"]);
    expect(kill.code, kill.stderr).toBe(0);
    const after = await invoke(home, ["task", "status", child, "--json"]);
    expect(after.code, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({
      state: "result_available",
      outcome: { outcome: "completed" },
    });
    const wait = await invoke(home, ["thread", "wait", child, "--tree", "--json"]);
    expect(wait.code, wait.stderr).toBe(0);
  } finally {
    await f.daemon.close();
  }
});

test("a provider-filtered kill stops a Claude parent while its Codex child keeps working", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const launched = await invoke(home, [
      "run",
      "Claude parent",
      "--provider",
      "claude",
      "--project",
      f.workspace,
      "--json",
    ]);
    const parent = identity.parse(JSON.parse(launched.stdout)).threadId;
    await f.daemon.engine?.flush();
    const delegated = await invoke(home, [
      "task",
      "spawn",
      "Codex child",
      "--parent",
      parent,
      "--provider",
      "codex",
      "--json",
    ]);
    const child = z.object({ data: identity }).parse(JSON.parse(delegated.stdout)).data.threadId;
    await f.daemon.engine?.flush();
    await f.h.emit(child, {
      type: "turn.started",
      agent: "root",
      trigger: "background_completion",
      nativeTurnId: "working-after-answer",
    });
    await f.daemon.engine?.flush();
    const killed = await invoke(home, [
      "kill-all",
      "--provider",
      "claude",
      "--idempotency-key",
      "claude-only",
      "--json",
    ]);
    expect(killed.code, killed.stderr).toBe(0);
    expect(JSON.parse(killed.stdout)).toMatchObject({
      data: { stopped: [parent], outcome: "cancelled" },
    });
    const status = await invoke(home, ["task", "status", child, "--json"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: "working" });
    expect(f.daemon.engine?.queue(child).lastFailure).toBeNull();
    const followup = await invoke(home, ["thread", "send", child, "still runnable", "--json"]);
    expect(followup.code, followup.stderr).toBe(0);
    await f.daemon.engine?.flush();
    expect(f.h.inputs.get(child)).toContain("still runnable");
  } finally {
    await f.daemon.close();
  }
});
