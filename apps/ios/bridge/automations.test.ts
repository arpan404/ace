import { afterEach, expect, test } from "vitest";
import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, type Automation, type AutomationRun, type ThreadStatus } from "@ace/protocol";
import { readAgents } from "./agent-read.ts";
import { ModelFavorites } from "./model-favorites.ts";
import { NativeAutomations, type NativeAutomationRequest } from "./automations.ts";

/*
 * The phone's Automations screens over the real SDK and an in-process fake daemon: the list's
 * words, a run history linked to threads, the friendly schedule form, GitHub and file triggers,
 * the shared model picker's pick, Duplicate and stale edits. No provider CLI runs.
 */

// Tuesday 27 October 2026, noon in London (GMT after the clocks went back).
const now = Date.UTC(2026, 9, 27, 12, 0);
const zone = "Europe/London";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function fixture(
  seed: { automations?: Automation[]; runs?: AutomationRun[] } = {},
  states: Record<string, ThreadStatus["state"]> = {},
) {
  const daemon = new FakeDaemon({ clock: () => now });
  daemon.seedServices({ settings: { "automations.enabled": true }, ...seed });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `read-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  close = () => client.close();
  const favorites = new ModelFavorites(client);
  const automations = new NativeAutomations({
    owner: client,
    now: () => now,
    zone: () => zone,
    agents: async () => (await readAgents(client, favorites, now)).agents,
    threadState: (threadId) => states[threadId],
  });
  const ask = (request: NativeAutomationRequest) =>
    automations.answer(request, new AbortController().signal);
  return { daemon, client, ask };
}

const base: Automation = {
  id: "nightly",
  title: "Nightly dependency check",
  enabled: true,
  workspace: "/Users/me/ace-next",
  provider: "claude",
  prompt: "Check for outdated dependencies",
  worktree: true,
  trigger: {
    kind: "schedule",
    schedule: {
      kind: "rrule",
      expression: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: zone,
      startAt: Date.UTC(2026, 9, 1, 8, 0),
    },
  },
  missedRun: "run_once",
  concurrency: 1,
  jitterMs: 0,
};

type Row = { id: string; title: string; enabled: boolean; automation: Automation } & Record<
  string,
  unknown
>;
const rows = (reply: Record<string, unknown>) => reply.person as Row[];

test("the list says how each automation runs, when it next starts and what needs the person", async () => {
  const github: Automation = {
    ...base,
    id: "labelled",
    title: "Triage labelled issues",
    trigger: {
      kind: "github",
      repository: "arpan404/ace",
      event: "issue_labelled",
      label: "bug",
      pollIntervalMs: 300_000,
    },
  };
  const paused: Automation = {
    ...base,
    id: "docs",
    title: "Docs watcher",
    enabled: false,
    trigger: { kind: "file", paths: ["docs/**/*.md"] },
  };
  const { ask, daemon } = await fixture({ automations: [base, github, paused] });
  daemon.seedServices({
    pollErrors: { labelled: { message: "HTTP 401 bad credentials", at: now - 60_000 } },
  });
  const page = await ask({ type: "automations.page", zone });
  expect(page.ok).toBe(true);
  const byId = new Map(rows(page).map((row) => [row.id, row]));
  expect(byId.get("nightly")).toMatchObject({
    when: "Every day at 9:00 AM",
    next: "Tomorrow 9:00 AM · in 21h",
    project: "ace-next",
    attention: null,
  });
  expect(byId.get("labelled")).toMatchObject({
    when: "When an issue is labelled (bug) in arpan404/ace",
    attention: { word: "Not watching", retry: true },
  });
  expect(byId.get("labelled")?.attention).toMatchObject({
    text: expect.stringMatching(/Sign in to GitHub/),
  });
  expect(byId.get("docs")).toMatchObject({
    when: "When docs/**/*.md change",
    next: "Paused. Resume to schedule the next run.",
    status: { word: "Paused" },
  });
});

test("runs read as turns linked to their threads, and a run waiting on the person never reads as working", async () => {
  const runs: AutomationRun[] = [
    {
      id: "done",
      automationId: "nightly",
      title: base.title,
      eventKey: "schedule:1",
      trigger: "schedule",
      status: "succeeded",
      startedAt: now - 3 * 3_600_000,
      finishedAt: now - 3 * 3_600_000 + 14 * 60_000,
      threadId: "t-done",
      result: "Two packages are out of date.",
    },
    {
      id: "broke",
      automationId: "nightly",
      title: base.title,
      eventKey: "schedule:2",
      trigger: "schedule",
      status: "failed",
      startedAt: now - 2 * 3_600_000,
      finishedAt: now - 2 * 3_600_000 + 120_000,
      threadId: "t-broke",
      result: "npm registry timed out",
    },
    {
      id: "asking",
      automationId: "nightly",
      title: base.title,
      eventKey: "manual:3",
      trigger: "manual",
      status: "running",
      startedAt: now - 60_000,
      threadId: "t-asking",
    },
  ];
  const { ask } = await fixture({ automations: [base], runs }, { "t-asking": "needs_you" });
  const history = await ask({ type: "automations.history", automationId: "nightly", zone });
  expect(history.ok).toBe(true);
  const turns = new Map((history.runs as Row[]).map((run) => [run.id, run]));
  expect(turns.get("done")).toMatchObject({
    threadId: "t-done",
    detail: "Worked for 14m",
    body: "Two packages are out of date.",
    head: null,
  });
  expect(turns.get("broke")).toMatchObject({
    head: { tone: "failed", word: "Failed" },
    detail: "after 2m",
    runAgain: true,
    threadId: "t-broke",
  });
  expect(turns.get("asking")).toMatchObject({
    head: { tone: "needsYou", word: "Needs you" },
    live: false,
    body: null,
  });
  // A run still going is read again soon.
  expect(history.pollMs).toBe(5_000);
});

test("a weekly schedule picked with friendly controls saves as an RRULE and opens as the same choices", async () => {
  const { ask } = await fixture();
  const opened = await ask({
    type: "automations.form.open",
    workspace: "/Users/me/ace-next",
    zone,
  });
  let form: Record<string, unknown> = {
    ...(opened.form as Record<string, unknown>),
    title: "Weekly report",
    prompt: "Summarise the week",
  };
  const weekly = await ask({
    type: "automations.form.preview",
    form: form as never,
    change: { cadence: "weekly" },
  });
  form = { ...(weekly.form as Record<string, unknown>), day: "TU" };
  const timed = await ask({
    type: "automations.form.preview",
    form: form as never,
    change: { time: Date.UTC(2026, 9, 27, 16, 30) },
  });
  expect(timed).toMatchObject({ summary: "Tuesdays at 4:30 PM", problem: null });
  expect(timed.upcoming).toEqual(["Today 4:30 PM", "Nov 3 4:30 PM", "Nov 10 4:30 PM"]);
  const saved = await ask({ type: "automations.save", form: timed.form as never, id: "weekly" });
  expect(saved).toEqual({ ok: true, id: "weekly" });
  const stored = rows(await ask({ type: "automations.page", zone })).find(
    (row) => row.id === "weekly",
  );
  expect(stored?.automation.trigger).toMatchObject({
    kind: "schedule",
    schedule: {
      kind: "rrule",
      expression: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=16;BYMINUTE=30",
      timezone: zone,
    },
  });
  const reopened = await ask({
    type: "automations.form.open",
    automation: stored?.automation,
    zone,
  });
  expect(reopened.form).toMatchObject({ cadence: "weekly", day: "TU", time: "16:30" });
});

test("a one-off run picked as an instant is kept as the wall clock of the schedule's zone", async () => {
  const { ask } = await fixture();
  const opened = await ask({ type: "automations.form.open", workspace: "/w", zone });
  const form = { ...(opened.form as Record<string, unknown>), timezone: "America/New_York" };
  const once = await ask({
    type: "automations.form.preview",
    form: form as never,
    change: { cadence: "once", at: Date.UTC(2026, 10, 3, 14, 30) },
  });
  expect(once.form).toMatchObject({ cadence: "once", date: "2026-11-03", time: "09:30" });
  expect(once.upcoming).toEqual(["Nov 3 9:30 AM"]);
});

test("a custom RRULE the daemon can't run is refused in the form and nothing is saved", async () => {
  const { ask } = await fixture();
  const opened = await ask({ type: "automations.form.open", workspace: "/w", zone });
  const form = {
    ...(opened.form as Record<string, unknown>),
    title: "Odd",
    prompt: "Go",
    cadence: "custom",
    syntax: "rrule",
    expression: "FREQ=BOGUS",
  };
  const preview = await ask({ type: "automations.form.preview", form: form as never });
  expect(preview.problem).toBe("Enter a valid RRULE, like FREQ=WEEKLY;BYDAY=MO.");
  const saved = await ask({ type: "automations.save", form: form as never, id: "odd" });
  expect(saved).toEqual({ ok: false, error: "Enter a valid RRULE, like FREQ=WEEKLY;BYDAY=MO." });
  expect(rows(await ask({ type: "automations.page", zone }))).toEqual([]);
});

test("GitHub and file triggers are created and edited from the form", async () => {
  const { ask } = await fixture();
  const opened = await ask({ type: "automations.form.open", workspace: "/w", zone });
  const named = {
    ...(opened.form as Record<string, unknown>),
    title: "Triage",
    prompt: "Triage it",
  };
  const github = await ask({
    type: "automations.form.preview",
    form: named as never,
    change: { trigger: "github" },
  });
  const unlabelled = {
    ...(github.form as Record<string, unknown>),
    repository: "arpan404/ace",
    event: "issue_labelled",
  };
  expect((await ask({ type: "automations.form.preview", form: unlabelled as never })).problem).toBe(
    "Name the label to watch for.",
  );
  const labelled = { ...unlabelled, label: "needs-triage" };
  expect(await ask({ type: "automations.save", form: labelled as never, id: "triage" })).toEqual({
    ok: true,
    id: "triage",
  });
  let stored = rows(await ask({ type: "automations.page", zone })).find(
    (row) => row.id === "triage",
  );
  expect(stored?.automation.trigger).toEqual({
    kind: "github",
    repository: "arpan404/ace",
    event: "issue_labelled",
    label: "needs-triage",
    pollIntervalMs: 300_000,
  });
  // Edited into a file trigger against the revision on screen.
  const edit = await ask({ type: "automations.form.open", automation: stored?.automation, zone });
  const files = await ask({
    type: "automations.form.preview",
    form: edit.form as never,
    change: { trigger: "file" },
  });
  const globbed = {
    ...(files.form as Record<string, unknown>),
    paths: "src/**/*.ts\n\n docs/*.md ",
  };
  expect(
    await ask({
      type: "automations.save",
      form: globbed as never,
      id: "ignored",
      previous: stored?.automation,
      revision: stored?.revision as number,
    }),
  ).toEqual({ ok: true, id: "triage" });
  stored = rows(await ask({ type: "automations.page", zone })).find((row) => row.id === "triage");
  expect(stored?.automation.trigger).toEqual({ kind: "file", paths: ["src/**/*.ts", "docs/*.md"] });
  // Saving again with the revision it was opened at is refused, not overwritten.
  const stale = await ask({
    type: "automations.save",
    form: globbed as never,
    id: "ignored",
    previous: stored?.automation,
    revision: 1,
  });
  expect(stale).toEqual({
    ok: false,
    error: "This automation changed elsewhere. Reload to see the latest, then try again.",
  });
});

test("a model picked in the shared picker is stored as its catalog id on its account, with its effort", async () => {
  const { ask, client } = await fixture();
  const agents = (await readAgents(client, new ModelFavorites(client), now)).agents;
  const opened = await ask({ type: "automations.form.open", workspace: "/w", zone });
  const pick = opened.pick as { provider: string; key: string; account: string };
  const row = agents.models.find(
    (model) => model.key === pick.key && model.account === pick.account,
  );
  expect(row).toBeDefined();
  const effort = row?.efforts.at(-1);
  const form = {
    ...(opened.form as Record<string, unknown>),
    title: "Model",
    prompt: "Go",
    trigger: "manual",
  };
  await ask({
    type: "automations.save",
    form: form as never,
    id: "model",
    pick: { ...pick, ...(effort ? { effort } : {}) },
  });
  const stored = rows(await ask({ type: "automations.page", zone })).find((r) => r.id === "model");
  expect(stored?.automation).toMatchObject({
    provider: pick.provider,
    model: row?.id,
    instance: pick.account,
    ...(effort ? { effort } : {}),
  });
  const reopened = await ask({
    type: "automations.form.open",
    automation: stored?.automation,
    zone,
  });
  expect(reopened.pick).toMatchObject({
    provider: pick.provider,
    key: pick.key,
    account: pick.account,
  });
});

test("Duplicate makes a paused copy that keeps what it watches", async () => {
  const { ask } = await fixture({ automations: [base] });
  expect(await ask({ type: "automations.duplicate", automation: base, id: "nightly-2" })).toEqual({
    ok: true,
    id: "nightly-2",
  });
  const copy = rows(await ask({ type: "automations.page", zone })).find(
    (row) => row.id === "nightly-2",
  );
  expect(copy).toMatchObject({ title: "Nightly dependency check copy", enabled: false });
  expect(copy?.automation.trigger).toEqual(base.trigger);
});

test("Run now, Pause and Delete answer in people's words, and a paused automation can't run", async () => {
  const { ask } = await fixture({ automations: [base] });
  const run = await ask({
    type: "automations.write",
    request: {
      type: "automation.run",
      id: "nightly",
      variables: {},
      message: "Only check the web app",
    },
  });
  expect(run).toEqual({ ok: true });
  const paused = await ask({
    type: "automations.write",
    request: { type: "automation.setEnabled", id: "nightly", enabled: false },
  });
  expect(paused).toEqual({ ok: true });
  expect(
    await ask({
      type: "automations.write",
      request: { type: "automation.run", id: "nightly", variables: {} },
    }),
  ).toEqual({ ok: false, error: "That automation is paused or no longer exists." });
  // Only these four writes pass; a definition change goes through the form.
  expect(
    await ask({ type: "automations.write", request: { type: "automation.put", automation: base } }),
  ).toMatchObject({ ok: false });
  expect(
    await ask({ type: "automations.write", request: { type: "automation.remove", id: "nightly" } }),
  ).toEqual({ ok: true });
  expect(rows(await ask({ type: "automations.page", zone }))).toEqual([]);
});
