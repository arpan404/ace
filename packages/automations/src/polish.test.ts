import { expect, test, vi } from "vitest";
import { definition, deferred, harness, start } from "./service-test-support.ts";
import type { GhResponse } from "./index.ts";

const github = () =>
  definition({
    trigger: {
      kind: "github",
      repository: "user/project",
      event: "pr_changed",
      pollIntervalMs: 60_000,
    },
  });
const list = (h: ReturnType<typeof harness>) =>
  h.service.handle({ type: "automation.list", requestId: "list" });

test("the last poll failure survives restart and a successful unchanged poll clears it", async () => {
  let failure = false;
  let baseline = false;
  const h = harness({
    async get(): Promise<GhResponse> {
      if (failure) throw new Error("GitHub sign-in required");
      if (baseline) return { status: 304, etag: undefined, next: undefined, data: undefined };
      baseline = true;
      return { status: 200, etag: "v1", next: undefined, data: [] };
    },
  });
  h.service.put(github());
  await h.timer.fire();
  await h.service.settled();
  failure = true;
  h.now = start + 60_000;
  await h.timer.fire();
  await h.service.settled();
  expect(list(h).schedules).toMatchObject([
    { id: "triage", lastPollError: { message: "GitHub sign-in required", at: start + 60_000 } },
  ]);
  h.restart();
  expect(list(h).schedules?.[0]?.lastPollError?.message).toBe("GitHub sign-in required");
  failure = false;
  h.now = start + 120_000;
  await h.timer.fire();
  await h.service.settled();
  expect(list(h).schedules?.[0]?.lastPollError).toBeUndefined();
});

test("an obsolete poll failure cannot mark a replaced automation as broken", async () => {
  const failed = deferred<void>();
  const h = harness({
    async get() {
      await failed.promise;
      throw new Error("Old repository failed");
    },
  });
  h.service.put(github());
  await h.timer.fire();
  h.service.put(definition({ title: "Manual replacement" }));
  failed.resolve();
  await h.service.settled();
  expect(list(h).schedules?.[0]?.lastPollError).toBeUndefined();
});

test("history filters before paging and tied timestamps leave no skipped or duplicate runs", async () => {
  const h = harness();
  h.service.put(definition({ prompt: "Review" }));
  h.service.put(definition({ id: "busy", prompt: "Review" }));
  for (let index = 0; index < 55; index++) {
    h.service.trigger("triage", { key: `quiet-${index}`, variables: {} });
    await h.finish(index);
  }
  for (let index = 0; index < 55; index++) {
    h.service.trigger("busy", { key: `busy-${index}`, variables: {} });
    await h.finish(index + 55);
  }
  const first = h.service.handle({
    type: "automation.inbox",
    requestId: "first",
    automationId: "triage",
    limit: 50,
  });
  expect(first.inbox?.runs).toHaveLength(50);
  expect(first.inbox?.runs.every((run) => run.automationId === "triage")).toBe(true);
  const older = h.service.handle({
    type: "automation.inbox",
    requestId: "older",
    automationId: "triage",
    limit: 50,
    before: first.inbox?.before,
  });
  expect(older.inbox?.runs.map((run) => run.eventKey)).toEqual([
    "quiet-4",
    "quiet-3",
    "quiet-2",
    "quiet-1",
    "quiet-0",
  ]);
  expect(
    new Set([...(first.inbox?.runs ?? []), ...(older.inbox?.runs ?? [])].map((run) => run.id)).size,
  ).toBe(55);
  expect(older.inbox?.before).toBeNull();
});

test("renaming an automation preserves its poll failure until another check succeeds", async () => {
  const h = harness({
    async get() {
      throw new Error("GitHub sign-in required");
    },
  });
  h.service.put(github());
  await h.timer.fire();
  await h.service.settled();
  h.service.put({ ...github(), title: "Renamed triage" });
  expect(list(h).schedules?.[0]?.lastPollError?.message).toBe("GitHub sign-in required");
  h.restart();
  expect(list(h).schedules?.[0]?.lastPollError?.message).toBe("GitHub sign-in required");
});

test("the inbox can leave out runs that finished by a time, keeping runs still going", async () => {
  const h = harness();
  h.service.put(definition({ prompt: "Review" }));
  h.service.put(definition({ id: "long", prompt: "Review" }));
  // The long run starts first and is still going while three short ones finish, a second apart.
  h.service.trigger("long", { key: "long-0", variables: {} });
  for (let index = 0; index < 3; index++) {
    h.service.trigger("triage", { key: `short-${index}`, variables: {} });
    await h.nextExecution(index + 1);
    h.now = start + index * 1_000;
    // `finish` waits for every run to settle; the long one is still going, so end this one alone.
    h.completions[index + 1]?.resolve({
      threadId: `t-${index}`,
      status: "succeeded",
      result: "Done",
    });
    await vi.waitFor(() =>
      expect(h.service.inbox().runs.find((run) => run.eventKey === `short-${index}`)?.status).toBe(
        "succeeded",
      ),
    );
  }
  const read = (finishedAfter: number, limit = 50, before?: number | null) =>
    h.service.handle({
      type: "automation.inbox",
      requestId: `after-${finishedAfter}-${before ?? "top"}`,
      limit,
      finishedAfter,
      ...(before ? { before } : {}),
    }).inbox;
  expect(read(start + 500)?.runs.map((run) => run.eventKey)).toEqual([
    "short-2",
    "short-1",
    "long-0",
  ]);
  // Paged, it still leaves nothing out and repeats nothing.
  const first = read(start + 500, 2);
  const rest = read(start + 500, 2, first?.before);
  expect([...(first?.runs ?? []), ...(rest?.runs ?? [])].map((run) => run.eventKey)).toEqual([
    "short-2",
    "short-1",
    "long-0",
  ]);
  expect(rest?.before).toBeNull();
  // The long run finishes last, so it is news after the newest short one.
  h.now = start + 5_000;
  await h.finish(0);
  expect(read(start + 2_000)?.runs.map((run) => run.eventKey)).toEqual(["long-0"]);
});
