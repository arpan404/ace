import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { definition, harness, scheduled, start } from "./service-test-support.ts";
import type { AutomationEvent } from "@ace/protocol";

const list = (h: ReturnType<typeof harness>, requestId: string) =>
  h.service.handle({ type: "automation.list", requestId });

it("an async watcher failure reaches the service without stopping healthy work", async () => {
  const h = harness();
  let fail = false;
  const errors = new Map<string, (error: unknown) => void>();
  h.deps.workspace = {
    subscribe(root, _paths, receive, hooks) {
      if (root === "/flaky" && fail) throw new Error("watcher unavailable");
      h.watches.set(root, receive);
      if (hooks?.onError) errors.set(root, hooks.onError);
      hooks?.onReady?.();
      return () => {
        h.watches.delete(root);
      };
    },
  };
  h.service.put(
    definition({ id: "flaky", workspace: "/flaky", trigger: { kind: "file", paths: ["src/**"] } }),
  );
  h.service.put(
    definition({
      id: "steady",
      workspace: "/steady",
      trigger: { kind: "file", paths: ["src/**"] },
    }),
  );
  expect(
    list(h, "before").schedules?.find((entry) => entry.id === "flaky")?.triggerError,
  ).toBeUndefined();
  // The source reports the loss asynchronously; the failure lands after install.
  errors.get("/flaky")?.(new Error("watcher lost"));
  await h.service.settled();
  expect(
    list(h, "broken").schedules?.find((entry) => entry.id === "flaky")?.triggerError?.message,
  ).toBe("watcher lost");
  // Healthy watchers keep delivering while the failed trigger waits.
  await h.watches.get("/steady")?.({ key: "steady-1", variables: { subject: "src/ok.ts" } });
  expect(h.inputs.map((input) => input.automationId)).toEqual(["steady"]);
  await h.finish(0);
  // A failed retry keeps the persisted error; only success clears it.
  fail = true;
  expect(
    h.service.handle({ type: "automation.retry", requestId: "retry-still-broken", id: "flaky" }),
  ).toMatchObject({ ok: false });
  expect(
    list(h, "kept").schedules?.find((entry) => entry.id === "flaky")?.triggerError?.message,
  ).toBe("watcher unavailable");
  fail = false;
  expect(
    h.service.handle({ type: "automation.retry", requestId: "retry-healed", id: "flaky" }),
  ).toMatchObject({
    ok: true,
  });
  expect(
    list(h, "healed").schedules?.find((entry) => entry.id === "flaky")?.triggerError,
  ).toBeUndefined();
  await h.watches.get("/flaky")?.({ key: "flaky-1", variables: { subject: "src/back.ts" } });
  expect(h.inputs.map((input) => input.automationId)).toEqual(["steady", "flaky"]);
  await h.finish(1);
  expect(
    list(h, "ready").schedules?.find((entry) => entry.id === "flaky")?.triggerError,
  ).toBeUndefined();
});

it("a corrupted COUNT cursor parks the schedule with health instead of hot-looping", async () => {
  const h = harness();
  const auto = scheduled("skip");
  if (auto.trigger.kind !== "schedule") throw new Error("Invalid test definition");
  auto.trigger.schedule.expression = "FREQ=DAILY;COUNT=3";
  h.service.put(auto);
  h.service.stop();
  const db = new DatabaseSync(h.storePath);
  try {
    db.prepare("UPDATE automation_state SET state=? WHERE id=?").run(
      JSON.stringify({ at: start + 10 * 86_400_000, ordinal: 1 }),
      "triage",
    );
  } finally {
    db.close();
  }
  // The overdue recovery hits the invalid cursor during startup isolation.
  h.now = start + 5 * 86_400_000;
  h.service.start();
  await h.service.settled();
  expect(h.inputs).toEqual([]);
  const entry = list(h, "parked").schedules?.[0];
  expect(entry?.nextRunAt).toBeNull();
  expect(entry?.triggerError?.message).toBe("Invalid counted cursor");
  // No hot loop: nothing is armed while parked, and health persists.
  expect(h.timer.active.size).toBe(0);
  await h.service.settled();
  expect(h.inputs).toEqual([]);
  expect(list(h, "still-parked").schedules?.[0]?.triggerError?.message).toBe(
    "Invalid counted cursor",
  );
  expect(h.errors.map(String).join(" ")).toContain("Invalid counted cursor");
});

it("an exhausted COUNT schedule finishes cleanly with no error and retry stays idle", async () => {
  const h = harness();
  const auto = scheduled("run_once");
  if (auto.trigger.kind !== "schedule") throw new Error("Invalid test definition");
  auto.trigger.schedule.expression = "FREQ=DAILY;COUNT=1";
  h.service.put(auto);
  h.now = start;
  await h.timer.fire();
  await h.finish();
  expect(h.timer.active.size).toBe(0);
  const entry = list(h, "exhausted").schedules?.[0];
  expect(entry?.nextRunAt).toBeNull();
  expect(entry?.triggerError).toBeUndefined();
  expect(
    h.service.handle({ type: "automation.retry", requestId: "retry-done", id: "triage" }),
  ).toMatchObject({
    ok: true,
  });
  expect(list(h, "still-done").schedules?.[0]?.triggerError).toBeUndefined();
  expect(list(h, "still-done").schedules?.[0]?.nextRunAt).toBeNull();
  await h.service.settled();
  expect(h.inputs).toHaveLength(1);
});

const githubDefinition = () =>
  definition({
    trigger: {
      kind: "github",
      repository: "user/project",
      event: "pr_changed",
      pollIntervalMs: 60_000,
    },
  });

it("a GitHub poll failure sets both compat and trigger health, cleared only by success", async () => {
  let failure = false;
  let baseline = false;
  const h = harness({
    async get() {
      if (failure) throw new Error("GitHub sign-in required");
      if (baseline) return { status: 304, etag: undefined, next: undefined, data: undefined };
      baseline = true;
      return { status: 200, etag: "v1", next: undefined, data: [] };
    },
  });
  const github = githubDefinition;
  h.service.put(github());
  await h.timer.fire();
  await h.service.settled();
  failure = true;
  h.now = start + 60_000;
  await h.timer.fire();
  await h.service.settled();
  const broken = list(h, "broken").schedules?.[0];
  expect(broken?.lastPollError?.message).toBe("GitHub sign-in required");
  expect(broken?.triggerError?.message).toBe("GitHub sign-in required");
  // Retry schedules an immediate poll but does not clear health first.
  expect(
    h.service.handle({ type: "automation.retry", requestId: "poll-again", id: "triage" }),
  ).toMatchObject({
    ok: true,
  });
  expect(list(h, "pending").schedules?.[0]?.triggerError?.message).toBe("GitHub sign-in required");
  failure = false;
  h.now = start + 120_000;
  await h.timer.fire();
  await h.service.settled();
  expect(list(h, "recovered").schedules?.[0]?.lastPollError).toBeUndefined();
  expect(list(h, "recovered").schedules?.[0]?.triggerError).toBeUndefined();
});

it("manual retries reuse the same executor key even after the run row is pruned", async () => {
  const h = harness();
  h.service.put(definition());
  const first = h.service.trigger("triage", {
    key: "manual:repeat",
    variables: { subject: "issues" },
  });
  expect(h.inputs[0]?.idempotencyKey).toBe(first.id);
  await h.finish();
  // Simulate retention eviction of the terminal row; the run history no longer dedupes.
  const db = new DatabaseSync(h.storePath);
  try {
    db.prepare("DELETE FROM automation_runs WHERE id=?").run(first.id);
  } finally {
    db.close();
  }
  const second = h.service.trigger("triage", {
    key: "manual:repeat",
    variables: { subject: "issues" },
  });
  expect(second.id).toBe(first.id);
  expect(h.inputs[1]?.idempotencyKey).toBe(first.id);
  await h.finish(1);
  expect(h.service.inbox().runs).toHaveLength(1);
});

it("pausing a schedule stops its timer and resuming restores its prompt", async () => {
  const h = harness();
  h.service.put(scheduled("skip"));
  expect(list(h, "armed").schedules?.[0]?.nextRunAt).not.toBeNull();
  h.service.setEnabled("triage", false);
  expect(h.service.list()).toMatchObject([{ enabled: false }]);
  expect(list(h, "paused").schedules?.[0]?.nextRunAt).toBeNull();
  h.service.setEnabled("triage", true);
  expect(h.service.list()).toMatchObject([{ enabled: true, prompt: "Triage {{scheduled_at}}" }]);
  expect(list(h, "resumed").schedules?.[0]?.nextRunAt).not.toBeNull();
  h.now = start;
  await h.timer.fire();
  expect(h.inputs[0]?.prompt).toBe("Triage 2024-01-01T09:00:00.000Z");
  await h.finish();
});

it("retry honors CAS revisions and rejects stale or missing ids", () => {
  const h = harness();
  h.service.put(definition({ trigger: { kind: "file", paths: ["src/**"] } }));
  const revision = list(h, "rev").schedules?.[0]?.revision;
  expect(typeof revision).toBe("number");
  expect(
    h.service.handle({
      type: "automation.retry",
      requestId: "stale",
      id: "triage",
      expectedRevision: (revision ?? 0) + 99,
    }),
  ).toMatchObject({ ok: false, error: "Automation revision conflict" });
  expect(
    h.service.handle({ type: "automation.retry", requestId: "absent", id: "missing" }),
  ).toMatchObject({ ok: false });
  expect(
    h.service.handle({
      type: "automation.retry",
      requestId: "fresh",
      id: "triage",
      expectedRevision: revision,
    }),
  ).toMatchObject({ ok: true });
  expect(list(h, "same").schedules?.[0]?.revision).toBe(revision);
});

it("obsolete async watcher failures cannot mark a replaced definition as broken", async () => {
  const h = harness();
  const reports = new Map<string, (error: unknown) => void>();
  h.deps.workspace = {
    subscribe(root, _paths, _receive, hooks) {
      if (hooks?.onError) reports.set(root, hooks.onError);
      return () => {};
    },
  };
  const first: AutomationEvent = { key: "first", variables: { subject: "a.ts" } };
  void first;
  h.service.put(definition({ workspace: "/one", trigger: { kind: "file", paths: ["src/**"] } }));
  const stale = reports.get("/one");
  if (!stale) throw new Error("Missing stale reporter");
  h.service.put(definition({ workspace: "/two", trigger: { kind: "file", paths: ["src/**"] } }));
  stale(new Error("Old watcher failed late"));
  await h.service.settled();
  expect(list(h, "replaced").schedules?.[0]?.triggerError).toBeUndefined();
  expect(h.errors.map(String).join(" ")).not.toContain("Old watcher failed late");
});

it("list schedules carry the authoritative latest run per automation", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.put(definition({ id: "other" }));
  expect(
    list(h, "empty").schedules?.find((entry) => entry.id === "triage")?.lastRun,
  ).toBeUndefined();
  const first = h.service.trigger("triage", { key: "one", variables: { subject: "a" } });
  await h.finish(0);
  const second = h.service.trigger("triage", { key: "two", variables: { subject: "b" } });
  await h.finish(1);
  h.service.trigger("other", { key: "one", variables: { subject: "c" } });
  await h.finish(2);
  const schedules = list(h, "runs").schedules;
  expect(schedules?.find((entry) => entry.id === "triage")?.lastRun).toMatchObject({
    id: second.id,
    eventKey: "two",
    status: "succeeded",
  });
  expect(schedules?.find((entry) => entry.id === "other")?.lastRun).toMatchObject({
    automationId: "other",
    eventKey: "one",
  });
  expect(first.id).not.toBe(second.id);
  h.restart();
  expect(
    h.service
      .handle({ type: "automation.list", requestId: "after-restart" })
      .schedules?.find((entry) => entry.id === "triage")?.lastRun?.id,
  ).toBe(second.id);
  await h.service.settled();
});

it("a late callback from a failed watcher admits nothing, while retry heals", async () => {
  const h = harness();
  const receivers: ((event: AutomationEvent) => Promise<void>)[] = [];
  const failures: ((error: unknown) => void)[] = [];
  let fail = false;
  h.deps.workspace = {
    subscribe(root, _paths, receive, hooks) {
      if (root === "/flaky" && fail) throw new Error("watcher unavailable");
      receivers.push(receive);
      if (hooks?.onError) failures.push(hooks.onError);
      hooks?.onReady?.();
      return () => {};
    },
  };
  h.service.put(definition({ workspace: "/flaky", trigger: { kind: "file", paths: ["src/**"] } }));
  const oldReceive = receivers.at(-1);
  if (!oldReceive) throw new Error("Missing watcher receiver");
  failures.splice(0).forEach((report) => report(new Error("watcher lost")));
  await h.service.settled();
  expect(list(h, "failed").schedules?.[0]?.triggerError?.message).toBe("watcher lost");
  await oldReceive({ key: "late", variables: { subject: "src/late.ts" } });
  await h.service.settled();
  expect(h.inputs).toEqual([]);
  expect(h.service.inbox().runs).toEqual([]);
  fail = true;
  expect(
    h.service.handle({ type: "automation.retry", requestId: "still-broken", id: "triage" }),
  ).toMatchObject({ ok: false });
  fail = false;
  expect(
    h.service.handle({ type: "automation.retry", requestId: "healed", id: "triage" }),
  ).toMatchObject({ ok: true });
  expect(list(h, "healed").schedules?.[0]?.triggerError).toBeUndefined();
  const freshReceive = receivers.at(-1);
  if (!freshReceive || freshReceive === oldReceive) throw new Error("Missing fresh receiver");
  await freshReceive({ key: "fresh", variables: { subject: "src/fresh.ts" } });
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Triage src/fresh.ts"]);
  await h.finish();
});
