import type { OffshiftRunCard } from "@ace/protocol/offshift";

/** An Offshift run card in delivery: what a run that thinks it is finished records. */
export function deliveredCard(updatedAt: number): OffshiftRunCard {
  return {
    id: "cleanup-run",
    outcome: "Process cleanup never signals a PID this daemon didn't start",
    outcomeTruncated: false,
    endpoint: "Merged PR with green checks",
    phase: "delivery",
    blocker: null,
    version: 9,
    updatedAt,
    revision: "cleanup-r4",
    criteria: [
      {
        id: "reuse",
        description: "A reused PID is never signalled",
        independent: true,
        evidence: [
          {
            kind: "automated",
            state: "pass",
            recordedAt: updatedAt,
            by: { provider: "codex", model: "gpt-6.1" },
          },
          {
            kind: "source",
            state: "pass",
            recordedAt: updatedAt,
            by: { provider: "claude", model: "claude-opus-5-5" },
          },
        ],
      },
    ],
    criteriaCount: 1,
    pending: [],
    pendingCount: 0,
    steps: [],
    playbook: "fix",
    next: "Report the outcome.",
  };
}

/** A run held in Verify by a blocker, with one failed and one missing check and its steps. */
export function blockedCard(updatedAt: number): OffshiftRunCard {
  return {
    id: "cleanup-run",
    outcome: "Process cleanup never signals a PID this daemon didn't start",
    outcomeTruncated: false,
    endpoint: "Merged PR with green checks",
    phase: "verify",
    blocker: "The Linux runner is offline, so the process-group test can't run there.",
    version: 6,
    updatedAt,
    revision: "cleanup-r3",
    criteria: [
      {
        id: "reuse",
        description: "A reused PID is never signalled",
        independent: true,
        evidence: [
          {
            kind: "automated",
            state: "fail",
            recordedAt: updatedAt,
            by: { provider: "codex", model: "gpt-6.1" },
          },
          {
            kind: "source",
            state: "pass",
            recordedAt: updatedAt,
            by: { provider: "claude", model: "claude-opus-5-5" },
          },
        ],
      },
      {
        id: "linux",
        description: "Cleanup works on Linux process groups",
        independent: false,
        evidence: [{ kind: "manual", state: "missing", recordedAt: null, by: null }],
      },
    ],
    criteriaCount: 2,
    pending: [
      { criterionId: "reuse", kind: "automated" },
      { criterionId: "linux", kind: "manual" },
    ],
    pendingCount: 2,
    steps: [
      { id: "repro", title: "Reproduce the reused-PID kill", state: "done" },
      { id: "linux", title: "Run the group test on Linux", state: "todo" },
      {
        id: "mac-ui",
        title: "Check the Activity Monitor view",
        state: "skipped",
        reason: "Not part of this fix",
      },
    ],
    playbook: "fix",
    next: "Resolve the blocker: The Linux runner is offline.",
  };
}
