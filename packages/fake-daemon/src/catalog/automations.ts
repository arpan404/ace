import { compileSchedule } from "@ace/automations/recurrence";
import type { Automation, AutomationRun } from "@ace/protocol";

const hour = 3_600_000;
const day = 24 * hour;

/** The approved design's automations: three schedules and a pull-request trigger. */
export function automationList(startAt: number, zone: string): Automation[] {
  const common = { missedRun: "run_once", concurrency: 1, jitterMs: 0 } as const;
  return [
    {
      ...common,
      id: "auto-dependency-audit",
      title: "Nightly dependency audit",
      enabled: true,
      workspace: "ace",
      provider: "claude",
      // A catalog row id: Sonnet on the work account.
      model: "claude-work:claude-sonnet-4-5",
      prompt:
        "Audit dependencies in each project for advisories, open one thread per project with a proposed fix, and link the advisory. Skip devDependencies.",
      worktree: true,
      trigger: {
        kind: "schedule",
        schedule: {
          kind: "rrule",
          expression: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0",
          timezone: zone,
          startAt,
        },
      },
    },
    {
      ...common,
      id: "auto-pr-review",
      title: "Review pull requests on open",
      enabled: true,
      workspace: "ace",
      provider: "codex",
      model: "codex-personal:gpt-5-codex",
      prompt:
        "Review the pull request against the repository's standards and the issue it links. Leave one summary comment, and line comments only for real problems.",
      worktree: true,
      trigger: {
        kind: "github",
        repository: "arpan404/ace",
        event: "pr_changed",
        pollIntervalMs: 300_000,
      },
    },
    {
      ...common,
      id: "auto-flaky-triage",
      title: "Flaky test triage",
      enabled: true,
      workspace: "ace",
      provider: "claude",
      prompt:
        "Run the test suite three times. For any test that both passes and fails, open a thread with the failing seed and a proposed fix.",
      worktree: true,
      trigger: {
        kind: "schedule",
        schedule: {
          kind: "rrule",
          expression: "FREQ=HOURLY;INTERVAL=6;BYMINUTE=0",
          timezone: zone,
          startAt,
        },
      },
    },
    {
      ...common,
      id: "auto-changelog",
      title: "Changelog draft",
      enabled: false,
      workspace: "ace",
      provider: "opencode",
      prompt:
        "Draft release notes from the pull requests merged since the last tag. Group them by area and lead with what users will notice.",
      worktree: false,
      missedRun: "skip",
      trigger: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 16 * * 5", timezone: zone, startAt },
      },
    },
  ];
}

const run = (
  id: string,
  automationId: string,
  title: string,
  ago: number,
  now: number,
  status: AutomationRun["status"],
  result: string,
  trigger: AutomationRun["trigger"] = "schedule",
  threadId?: string,
): AutomationRun => ({
  id,
  automationId,
  title,
  eventKey: `${automationId}:${id}`,
  trigger,
  status,
  // Never before the epoch, whatever clock a test starts from.
  startedAt: Math.max(0, now - ago),
  finishedAt: Math.max(0, now - ago) + 4 * 60_000,
  result,
  ...(threadId ? { threadId } : {}),
});

/** Recent runs, newest first, timed relative to `now`. */
export function automationRuns(now: number, zone = "UTC"): AutomationRun[] {
  const audit = "Nightly dependency audit";
  const review = "Review pull requests on open";
  const runs = [
    run(
      "run-review-212",
      "auto-pr-review",
      review,
      41 * 60_000,
      now,
      "succeeded",
      "#212 · approved with 1 note",
      "github",
      "thread-bump-codex",
    ),
    run(
      "run-flaky-1",
      "auto-flaky-triage",
      "Flaky test triage",
      2 * hour,
      now,
      "succeeded",
      "Nothing flaky across 3 runs",
    ),
    run(
      "run-review-209",
      "auto-pr-review",
      review,
      5 * hour,
      now,
      "succeeded",
      "#209 · requested changes",
      "github",
      "thread-worktree-cleanup",
    ),
    run(
      "run-audit-1",
      "auto-dependency-audit",
      audit,
      6 * hour,
      now,
      "succeeded",
      "2 advisories · opened a thread in ace",
      "schedule",
      "thread-bump-codex",
    ),
    run("run-audit-2", "auto-dependency-audit", audit, day, now, "succeeded", "Nothing to fix"),
    run(
      "run-audit-3",
      "auto-dependency-audit",
      audit,
      2 * day,
      now,
      "succeeded",
      "1 advisory · fix merged as #203",
    ),
    run(
      "run-audit-4",
      "auto-dependency-audit",
      audit,
      3 * day,
      now,
      "failed",
      "npm registry timeout, retried once",
    ),
    run(
      "run-changelog-1",
      "auto-changelog",
      "Changelog draft",
      6 * day,
      now,
      "succeeded",
      "Draft posted to #releases",
    ),
  ];
  const schedules = automationList(
    Math.max(0, Math.floor((now - 30 * day) / 60_000) * 60_000),
    zone,
  );
  return runs.flatMap((record) => {
    const automation = schedules.find((entry) => entry.id === record.automationId);
    if (record.trigger !== "schedule" || automation?.trigger.kind !== "schedule") return [record];
    const recurrence = compileSchedule(automation.trigger.schedule);
    let cursor = Math.max(-1, record.startedAt - 8 * day);
    let latest: number | undefined;
    for (let i = 0; i < 512; i++) {
      const next = recurrence.next(cursor);
      if (next === undefined || next > record.startedAt) break;
      latest = cursor = next;
    }
    return latest === undefined
      ? []
      : [{ ...record, startedAt: latest, finishedAt: latest + 4 * 60_000 }];
  });
}
