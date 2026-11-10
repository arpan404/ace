import { join } from "node:path";
import { createInstance, openRegistry } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { expect, test, vi } from "vitest";
import { MonitorSnapshot, ThreadId } from "@ace/protocol";
import { z } from "zod";
import { start } from "../engine/test-support.ts";
import { pairedMachines } from "./machine-test-support.ts";

const delegated = z.object({ threadId: ThreadId });
const task = {
  op: "delegate_task",
  requestId: "settle",
  task: "Review changes",
  role: "Review-delegation-failures",
  provider: "claude",
  machine: "studio",
  project: "project",
} as const;

test("a remote success reaches an active steering parent before that parent ends its turn", async () => {
  const pair = await pairedMachines({ access: "operate", sourceSteer: true });
  await pair.source.call({ op: "machines" });
  const child = delegated.parse((await pair.source.call(task)).data).threadId;
  const parent = pair.source.caller.threadId;
  pair.source.h.contexts.get(parent)?.onFrame(pair.source.h.frames.frame(start));
  await pair.source.daemon.engine?.flush();
  expect(pair.source.daemon.store.getThread(parent)?.status.state).toBe("working");
  await pair.finishTask(child, task.task, "Reviewed successfully");
  await vi.waitFor(
    () => expect(pair.source.h.inputs.get(parent)?.join("\n")).toContain("Reviewed successfully"),
    { timeout: 10_000 },
  );
  expect(pair.source.h.inputMessages.get(parent)?.at(-1)?.delivery).toBe("steer");
});

test("remote usage failure is readable and delivered without cancellation, including after source restart", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const child = delegated.parse((await pair.source.call(task)).data).threadId;
  await vi.waitFor(() => expect(pair.target.h.inputs.get(child)?.join("\n")).toContain(task.task), {
    timeout: 10_000,
  });
  await pair.emit(
    child,
    { type: "retry", agent: "root", on: "rate_limit", until: 5000, message: "Quota exhausted" },
    {
      type: "turn.ended",
      agent: "root",
      outcome: "failed",
      error: { kind: "quota", message: "Quota exhausted" },
    },
  );
  await vi.waitFor(
    async () => {
      const status = await pair.source.call({ op: "agents.status" });
      expect(status.data).toMatchObject({
        children: [
          expect.objectContaining({
            id: child,
            state: "failed",
            failure: expect.objectContaining({
              code: "usage_limited",
              resetsAt: 5000,
              accountId: "claude-cli-default",
              message: expect.any(String),
            }),
            result: expect.stringContaining("Usage limit reached"),
          }),
        ],
      });
    },
    { timeout: 10_000 },
  );
  await vi.waitFor(
    () =>
      expect(pair.source.h.inputs.get(pair.source.caller.threadId)?.join("\n")).toContain(
        "Usage limit reached",
      ),
    { timeout: 10_000 },
  );
  await pair.restartSource();
  const status = await pair.source.call({ op: "agents.status" });
  expect(status.data).toMatchObject({
    children: [
      expect.objectContaining({
        id: child,
        state: "failed",
        failure: expect.objectContaining({ code: "usage_limited" }),
      }),
    ],
  });

  // The limit resets there. The child's stop is the same stop: no second result, same reason.
  const told = () =>
    (pair.source.h.inputs.get(pair.source.caller.threadId) ?? []).filter((text) =>
      text.includes("Usage limit reached"),
    ).length;
  const before = told();
  pair.target.h.clock.advance(6_000);
  await pair.target.daemon.engine?.flush();
  expect(pair.target.daemon.store.getThread(child)?.status.state).not.toBe("limited");
  // Settled children are read again at the slower re-check pace: give it several turns.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(told()).toBe(before);
  const after = await pair.source.call({ op: "agents.status" });
  expect(after.data).toMatchObject({
    children: [
      expect.objectContaining({
        id: child,
        state: "failed",
        failure: expect.objectContaining({ code: "usage_limited", resetsAt: 5000 }),
      }),
    ],
  });
});

test("a known limited remote account is refused before launch and names other available accounts", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const registry = await openRegistry(join(pair.target.h.home, "daemon", "accounts.sqlite"));
  try {
    await registry.register(
      createInstance({
        id: "available",
        label: "Available",
        provider: "claude",
        homeDir: pair.target.h.home,
      }),
    );
    registry.ingest("claude-cli-default", {
      provider: "claude",
      observedAt: pair.target.h.clock.now(),
      timeZone: "UTC",
      payload: new ProviderPayload(
        JSON.stringify({ usageWindows: { session: { usedPercent: 100, resetsAt: 500000 } } }),
      ),
    });
  } finally {
    registry.close();
  }
  await pair.source.call({ op: "machines" });
  const before = pair.target.daemon.store.listThreads().length;
  await expect(
    pair.source.call({ ...task, accountId: "claude-cli-default" }),
  ).rejects.toMatchObject({
    detail: expect.stringMatching(/at its limit.*Available \(available\)/),
  });
  expect(pair.target.daemon.store.listThreads()).toHaveLength(before);
});

test("a remote child failed on its limit reads working again when work starts there without a new run", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const child = delegated.parse((await pair.source.call(task)).data).threadId;
  await vi.waitFor(() => expect(pair.target.h.inputs.get(child)?.join("\n")).toContain(task.task), {
    timeout: 10_000,
  });
  await pair.emit(child, {
    type: "turn.ended",
    agent: "root",
    outcome: "failed",
    error: { kind: "quota", message: "Quota exhausted" },
  });
  const stateHere = async () =>
    MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children.find(
      (row) => row.id === child,
    )?.state;
  await vi.waitFor(async () => expect(await stateHere()).toBe("failed"), { timeout: 10_000 });

  // A background task the provider started late reports in; no new run begins.
  await pair.emit(child, {
    type: "background.started",
    agent: "root",
    task: "late-watch",
    kind: "shell",
    title: "Watch CI",
    stoppable: true,
  });
  await vi.waitFor(async () => expect(await stateHere()).toBe("working"), { timeout: 10_000 });
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status.state).not.toBe(
    "done",
  );
}, 60_000);

test("a remote child whose limit is reported after its turn already failed gives its parent that reason", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const child = delegated.parse((await pair.source.call(task)).data).threadId;
  await vi.waitFor(() => expect(pair.target.h.inputs.get(child)?.join("\n")).toContain(task.task), {
    timeout: 10_000,
  });
  const parent = pair.source.caller.threadId;
  const told = () => pair.source.h.inputs.get(parent)?.join("\n") ?? "";
  // Codex ends the turn on systemError first; the parent hears a failure with no reason.
  await pair.emit(child, {
    type: "turn.ended",
    agent: "root",
    outcome: "failed",
    error: { kind: "provider", message: "Codex thread reported systemError" },
  });
  await vi.waitFor(() => expect(told()).toContain("systemError"), { timeout: 10_000 });
  expect(told()).not.toContain("Usage limit reached");

  await pair.emit(child, {
    type: "retry",
    agent: "root",
    on: "rate_limit",
    until: 5000,
    message: "Quota exhausted",
  });
  await vi.waitFor(() => expect(told()).toContain("Usage limit reached"), { timeout: 20_000 });
  const status = MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data);
  expect(status.children.find((row) => row.id === child)).toMatchObject({
    state: "failed",
    failure: { code: "usage_limited" },
  });
}, 60_000);
