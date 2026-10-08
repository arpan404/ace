import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";
import { workbenchServices } from "./scenarios/services.ts";
import { compileSchedule } from "@ace/automations/recurrence";

test("nightly fixture runs follow their actual schedule in the selected timezone", () => {
  const now = Date.UTC(2026, 9, 8, 13, 57, 15);
  for (const zone of ["America/Chicago", "Asia/Kolkata", "UTC"]) {
    const seed = workbenchServices(now, zone);
    const automation = seed.automations?.find((a) => a.id === "auto-dependency-audit");
    if (automation?.trigger.kind !== "schedule") throw new Error("Missing audit");
    const schedule = {
      ...automation.trigger.schedule,
      startAt: Math.floor(now / 60_000) * 60_000 - 10 * 86_400_000,
    };
    const recurrence = compileSchedule(schedule);
    for (const run of seed.runs?.filter((r) => r.automationId === automation.id) ?? [])
      expect(recurrence.next(run.startedAt - 1)).toBe(run.startedAt);
  }
});

test("a fresh fake thread finishes reading and accepts a follow-up", () => {
  const pending: (() => void)[] = [];
  const daemon = new FakeDaemon({
    clock: () => 1000,
    threadCompletionSchedule: (cb) => pending.push(cb),
  });
  const command = (id: string, payload: unknown) =>
    daemon.command(Command.parse({ id, deviceId: "device", payload }));
  const result = command("first", {
    type: "thread.create",
    workspaceId: "project",
    provider: "codex",
    input: [{ type: "text", text: "Inspect the project" }],
  });
  expect(result.ok).toBe(true);
  for (const complete of pending.splice(0)) complete();
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-first") });
  expect(view).toMatchObject({ thread: { status: { state: "done" } } });
  if (view?.kind !== "thread") throw new Error("Missing thread");
  expect(Object.values(view.items)).toContainEqual(
    expect.objectContaining({ type: "message", role: "assistant", complete: true }),
  );
  expect(
    command("follow", {
      type: "thread.send",
      threadId: "thread-first",
      input: [{ type: "text", text: "Continue" }],
    }).ok,
  ).toBe(true);
});
