import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Automation, AutomationRun } from "@ace/protocol";
import { seedRequest } from "./request-scenarios.ts";

/*
 * Automations for the spike daemon: one of every trigger (a daily schedule, a weekly one in
 * another zone, every few hours, a one-off, a custom RRULE, a cron, GitHub pull requests,
 * labelled issues, file changes, by hand), one paused, one whose GitHub check fails, and a run
 * history whose runs link to real threads: finished, failed, still working and one waiting on
 * the person. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;
const minute = 60_000;
const hour = 60 * minute;
const workspace = "/tmp/ace-ios-spike";

function automation(
  id: string,
  title: string,
  trigger: Automation["trigger"],
  patch: Partial<Automation> = {},
): Automation {
  return {
    id,
    title,
    enabled: true,
    workspace,
    provider: "codex",
    prompt: `${title}. Report what changed and open a pull request if anything needs fixing.`,
    worktree: true,
    trigger,
    missedRun: "run_once",
    concurrency: 1,
    jitterMs: 0,
    ...patch,
  };
}

function thread(
  daemon: FakeDaemon,
  details: Details,
  id: string,
  title: string,
  answer: string | undefined,
) {
  daemon.createThread({
    hasSentMessage: true,
    id,
    workspaceId: "ace",
    title,
    provider: "codex",
    details: details(`automation/${id}`),
  });
  daemon.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", title),
    ...(answer
      ? [facts.message("root", "answer", "assistant", answer), facts.endTurn("root")]
      : []),
  ]);
}

export function seedAutomations(daemon: FakeDaemon, details: Details, now: number): void {
  const schedule = (
    expression: string,
    timezone = "Europe/London",
    kind: "rrule" | "cron" = "rrule",
  ) => ({
    kind: "schedule" as const,
    schedule: {
      kind,
      expression,
      timezone,
      startAt: Math.floor((now - 30 * 24 * hour) / minute) * minute,
    },
  });
  const automations = [
    automation(
      "auto-nightly",
      "Check dependencies every night",
      schedule("FREQ=DAILY;BYHOUR=2;BYMINUTE=0"),
    ),
    automation(
      "auto-standup",
      "Write the standup notes",
      schedule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30"),
    ),
    automation(
      "auto-weekly",
      "Weekly release summary",
      schedule("FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0", "America/New_York"),
    ),
    automation("auto-hours", "Sweep flaky tests", schedule("FREQ=HOURLY;INTERVAL=6;BYMINUTE=0")),
    automation(
      "auto-monthly",
      "Monthly licence audit",
      schedule("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0"),
    ),
    automation(
      "auto-cron",
      "Rotate preview builds",
      schedule("30 7 * * 1-5", "Europe/London", "cron"),
    ),
    automation("auto-prs", "Review new pull requests", {
      kind: "github",
      repository: "arpan404/ace",
      event: "pr_changed",
      pollIntervalMs: 300_000,
    }),
    automation("auto-triage", "Triage bug reports", {
      kind: "github",
      repository: "arpan404/ace",
      event: "issue_labelled",
      label: "bug",
      pollIntervalMs: 300_000,
    }),
    automation("auto-docs", "Keep the docs index current", {
      kind: "file",
      paths: ["docs/**/*.md", "README.md"],
    }),
    automation("auto-manual", "Cut a release candidate", { kind: "manual" }),
    automation(
      "auto-paused",
      "Archive stale branches",
      schedule("FREQ=WEEKLY;BYDAY=SU;BYHOUR=20;BYMINUTE=0"),
      { enabled: false },
    ),
  ];
  thread(
    daemon,
    details,
    "ios-auto-done",
    "Check dependencies every night",
    "Two packages are out of date: zod 4.6.7 and vitest 5.0.3. Both are patch releases; I opened #1490 to bump them and the suite passes.",
  );
  thread(
    daemon,
    details,
    "ios-auto-failed",
    "Check dependencies every night",
    "npm registry timed out after three tries.",
  );
  thread(daemon, details, "ios-auto-working", "Sweep flaky tests", undefined);
  seedRequest(daemon, "approval", "ios-auto-asking", details);
  const run = (id: string, automationId: string, patch: Partial<AutomationRun>): AutomationRun => ({
    id,
    automationId,
    title: automations.find((entry) => entry.id === automationId)?.title ?? automationId,
    eventKey: `seed:${id}`,
    trigger: "schedule",
    status: "succeeded",
    startedAt: now - hour,
    ...patch,
  });
  const runs: AutomationRun[] = [
    run("run-nightly-1", "auto-nightly", {
      startedAt: now - 3 * 24 * hour,
      finishedAt: now - 3 * 24 * hour + 9 * minute,
      result: "Everything is current. Nothing to do.",
    }),
    run("run-nightly-2", "auto-nightly", {
      status: "failed",
      startedAt: now - 2 * 24 * hour,
      finishedAt: now - 2 * 24 * hour + 2 * minute,
      threadId: "ios-auto-failed",
      result: "npm registry timed out after three tries.",
    }),
    run("run-nightly-3", "auto-nightly", {
      startedAt: now - 10 * hour,
      finishedAt: now - 10 * hour + 14 * minute,
      threadId: "ios-auto-done",
      result:
        "Two packages are out of date: zod 4.6.7 and vitest 5.0.3. Both are patch releases; I opened #1490 to bump them and the suite passes.",
    }),
    run("run-nightly-4", "auto-nightly", {
      trigger: "manual",
      status: "running",
      startedAt: now - 4 * minute,
      threadId: "ios-auto-asking",
    }),
    run("run-hours-1", "auto-hours", {
      status: "running",
      startedAt: now - 7 * minute,
      threadId: "ios-auto-working",
    }),
    run("run-triage-1", "auto-triage", {
      trigger: "github",
      startedAt: now - 5 * hour,
      finishedAt: now - 5 * hour + 3 * minute,
      result: "Labelled #1471 as a duplicate of #1402.",
    }),
  ];
  daemon.seedServices({
    settings: { "automations.enabled": true },
    automations,
    runs,
    pollErrors: { "auto-prs": { message: "HTTP 401: Bad credentials", at: now - 40 * minute } },
  });
}
