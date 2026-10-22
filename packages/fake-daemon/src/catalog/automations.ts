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
      // A catalog row id: Sonnet on the work account, as the composer's chip picks it.
      model: "claude-work:claude-sonnet-4-5",
      effort: "high",
      instance: "claude-work",
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
      effort: "medium",
      instance: "codex-personal",
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
  minutes = 4,
): AutomationRun => ({
  id,
  automationId,
  title,
  eventKey: `${automationId}:${id}`,
  trigger,
  status,
  // Never before the epoch, whatever clock a test starts from.
  startedAt: Math.max(0, now - ago),
  finishedAt: Math.max(0, now - ago) + minutes * 60_000,
  result,
  ...(threadId ? { threadId } : {}),
});

/** Recent runs, newest first, timed relative to `now`. */
export function automationRuns(now: number, zone = "UTC"): AutomationRun[] {
  const audit = "Nightly dependency audit";
  // Scheduled runs snap to their schedule's last time before `ago`; whole days apart, the
  // nightly audit's runs land on four different nights at any hour of the day.
  const review = "Review pull requests on open";
  const runs = [
    run(
      "run-review-212",
      "auto-pr-review",
      review,
      41 * 60_000,
      now,
      "succeeded",
      "Approved #212 with one note: the Codex 0.48 bump changes the default sandbox, so the release notes should say so.",
      "github",
      "thread-bump-codex",
      6,
    ),
    run(
      "run-flaky-1",
      "auto-flaky-triage",
      "Flaky test triage",
      2 * hour,
      now,
      "succeeded",
      "Ran the suite three times: 1,284 tests passed every time. Nothing flaky, so no threads opened.",
      "schedule",
      undefined,
      17,
    ),
    run(
      "run-review-209",
      "auto-pr-review",
      review,
      5 * hour,
      now,
      "succeeded",
      "Requested changes on #209: deleting a thread removes its worktree before the agent stops, which can lose unsaved edits. Left two line comments.",
      "github",
      "thread-worktree-cleanup",
      9,
    ),
    run(
      "run-audit-1",
      "auto-dependency-audit",
      audit,
      0,
      now,
      "succeeded",
      "Found 2 advisories: a moderate one in undici and a low one in semver. Opened a thread in ace with the undici upgrade; semver needs no change because the affected range isn't used.",
      "schedule",
      "thread-bump-codex",
      12,
    ),
    run(
      "run-audit-2",
      "auto-dependency-audit",
      audit,
      day,
      now,
      "succeeded",
      "No new advisories in any project. Nothing to fix.",
      "schedule",
      undefined,
      3,
    ),
    run(
      "run-audit-3",
      "auto-dependency-audit",
      audit,
      2 * day,
      now,
      "succeeded",
      "One advisory in ws (denial of service on malformed frames). Upgraded to 8.18.1; the fix merged as #203.",
      "schedule",
      undefined,
      14,
    ),
    run(
      "run-audit-4",
      "auto-dependency-audit",
      audit,
      3 * day,
      now,
      "failed",
      "The npm registry timed out twice while reading advisories, so the audit stopped. It runs again tonight.",
      "schedule",
      undefined,
      2,
    ),
    run(
      "run-changelog-1",
      "auto-changelog",
      "Changelog draft",
      6 * day,
      now,
      "succeeded",
      "Drafted release notes for 11 merged pull requests, grouped by area, and posted them to #releases.",
      "schedule",
      undefined,
      5,
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
    const took = (record.finishedAt ?? record.startedAt) - record.startedAt;
    return latest === undefined
      ? []
      : [{ ...record, startedAt: latest, finishedAt: latest + took }];
  });
}

/** Automations agents made from Home threads: each belongs to the thread that made it. */
export function threadAutomationList(
  startAt: number,
  zone: string,
): { threadId: string; automation: Automation }[] {
  const common = { missedRun: "skip", concurrency: 1, jitterMs: 0, worktree: false } as const;
  return [
    {
      threadId: "thread-checkout",
      automation: {
        ...common,
        id: "agent-checkout-soak",
        title: "Re-run the checkout test overnight",
        enabled: true,
        workspace: "billing-api",
        provider: "claude",
        effort: "medium",
        prompt:
          "Run the checkout integration test 25 times against the fixed retry logic and report any failure with its seed.",
        trigger: {
          kind: "schedule",
          schedule: {
            kind: "rrule",
            expression: "FREQ=DAILY;BYHOUR=3;BYMINUTE=30",
            timezone: zone,
            startAt,
          },
        },
      },
    },
    {
      threadId: "thread-worktree-cleanup",
      automation: {
        ...common,
        id: "agent-worktree-sweep",
        title: "Sweep orphaned worktrees",
        enabled: true,
        workspace: "ace",
        provider: "codex",
        prompt:
          "List worktrees under ~/.ace/worktrees whose thread is gone and remove the ones with no unpushed commits.",
        trigger: { kind: "manual" },
      },
    },
  ];
}

/** Runs of the agents' automations, newest first. */
export function threadAutomationRuns(now: number): AutomationRun[] {
  return [
    run(
      "run-checkout-soak-2",
      "agent-checkout-soak",
      "Re-run the checkout test overnight",
      7 * hour,
      now,
      "succeeded",
      "25 of 25 runs passed. The longest took 4.2s, well under the 10s timeout that used to trip.",
      "schedule",
      "thread-checkout",
      11,
    ),
    run(
      "run-checkout-soak-1",
      "agent-checkout-soak",
      "Re-run the checkout test overnight",
      day + 7 * hour,
      now,
      "failed",
      "24 of 25 runs passed. Seed 81733 failed: the payment mock answered after the order was cancelled. The thread has the log.",
      "schedule",
      "thread-checkout",
      13,
    ),
    run(
      "run-worktree-sweep-1",
      "agent-worktree-sweep",
      "Sweep orphaned worktrees",
      3 * hour,
      now,
      "succeeded",
      "Removed 3 orphaned worktrees (1.8 GB). Kept fix/old-relay because it has 2 unpushed commits.",
      "manual",
      "thread-worktree-cleanup",
      2,
    ),
  ];
}
