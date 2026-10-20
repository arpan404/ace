import {
  OffshiftPlaybooks,
  type OffshiftPlaybook,
  type OffshiftPlaybookId,
  type OffshiftPlaybookStep,
} from "@ace/protocol/offshift";

/*
 * Built-in playbooks: for each kind of work, the steps that separate verified work from a
 * plausible-looking diff. Pure data; it ships in tool results, so every line stays short.
 */
const report: OffshiftPlaybookStep = {
  id: "report",
  title: "Report what changed and the evidence behind each claim; label anything unverified",
  phase: "delivery",
};
const review: OffshiftPlaybookStep = {
  id: "review",
  title: "Have another provider review a consequential diff, or skip with why it is trivial",
  phase: "review",
  kinds: ["source"],
};

const playbooks: readonly OffshiftPlaybook[] = [
  {
    id: "fix",
    purpose: "Repair a defect at its root and prove it on the surface where it showed.",
    steps: [
      {
        id: "reproduce",
        title: "Reproduce the defect on the surface where it was reported",
        phase: "plan",
        kinds: ["ui", "manual"],
      },
      {
        id: "root-cause",
        title: "Find the first point where the system went wrong",
        phase: "plan",
      },
      {
        id: "failing-test",
        title: "Write a behaviour test that fails because of the defect",
        phase: "implement",
        kinds: ["automated"],
      },
      {
        id: "root-fix",
        title: "Make the smallest change at the root; remove workarounds it replaces",
        phase: "implement",
      },
      {
        id: "same-surface",
        title: "Confirm the fix on the same surface, and that the new test now passes",
        phase: "verify",
        kinds: ["ui", "automated"],
      },
      review,
      { ...report, title: "Report the cause, the fix and the check behind each claim" },
    ],
  },
  {
    id: "feature",
    purpose: "Add one observable capability and nothing beyond it.",
    steps: [
      {
        id: "shape",
        title: "Name the data shape and the observable behaviour before writing code",
        phase: "plan",
      },
      { id: "owner", title: "Find the module that already owns this and extend it", phase: "plan" },
      {
        id: "build",
        title: "Build the smallest version that delivers the outcome",
        phase: "implement",
      },
      {
        id: "tests",
        title: "Add tests that assert what a user or caller observes",
        phase: "implement",
        kinds: ["automated"],
      },
      {
        id: "real-surface",
        title: "Use the feature where people will use it, not through a proxy",
        phase: "verify",
        kinds: ["ui", "manual"],
      },
      review,
      report,
    ],
  },
  {
    id: "refactor",
    purpose: "Change structure while every observable behaviour stays the same.",
    steps: [
      {
        id: "pin",
        title: "Make sure tests cover the behaviour you will touch; add the missing ones first",
        phase: "plan",
        kinds: ["automated"],
      },
      { id: "target", title: "State the target structure and why it is simpler", phase: "plan" },
      {
        id: "small-moves",
        title: "Move in small steps and keep the tests green after each",
        phase: "implement",
      },
      { id: "delete", title: "Delete the code the new structure replaces", phase: "implement" },
      {
        id: "same-results",
        title: "Run the same tests as before the change and compare results",
        phase: "verify",
        kinds: ["automated"],
      },
      {
        id: "no-drift",
        title: "Read the diff for any behaviour change and justify or revert each",
        phase: "review",
        kinds: ["source"],
      },
      report,
    ],
  },
  {
    id: "perf",
    purpose: "Make something measurably faster or lighter without changing what it does.",
    steps: [
      {
        id: "baseline",
        title: "Measure the current cost on a realistic workload and keep the numbers",
        phase: "plan",
        kinds: ["manual"],
      },
      { id: "profile", title: "Profile to find where the time or memory goes", phase: "plan" },
      { id: "hot-spot", title: "Change only what the profile points at", phase: "implement" },
      {
        id: "remeasure",
        title: "Measure again the same way and compare with the baseline",
        phase: "verify",
        kinds: ["manual", "automated"],
      },
      {
        id: "still-correct",
        title: "Run the behaviour tests around the change",
        phase: "verify",
        kinds: ["automated"],
      },
      review,
      { ...report, title: "Report before and after numbers and how they were taken" },
    ],
  },
  {
    id: "investigate",
    purpose: "Answer a question from evidence without changing code.",
    steps: [
      {
        id: "question",
        title: "Restate the question and what would count as an answer",
        phase: "plan",
      },
      {
        id: "gather",
        title: "Read the code, logs and data that bear on it; run experiments instead of guessing",
        phase: "verify",
        kinds: ["source"],
      },
      {
        id: "counter",
        title: "Look for evidence against your answer before settling on it",
        phase: "review",
      },
      {
        id: "cited-answer",
        title: "Answer with a file and line, or command output, for every claim",
        phase: "delivery",
      },
    ],
  },
  {
    id: "ui",
    purpose: "Change what people see or do, checked in the running app.",
    steps: [
      {
        id: "current",
        title: "Open the running app and note how it behaves now",
        phase: "plan",
        kinds: ["ui"],
      },
      {
        id: "conventions",
        title: "Read the project's design rules and the components it already has",
        phase: "plan",
      },
      {
        id: "build",
        title: "Build it from existing components and words; add no new pattern without need",
        phase: "implement",
      },
      {
        id: "tests",
        title: "Add a test of the visible behaviour",
        phase: "implement",
        kinds: ["automated"],
      },
      {
        id: "in-app",
        title: "Use it in the running app at narrow and wide sizes, keyboard included",
        phase: "verify",
        kinds: ["ui"],
      },
      review,
      { ...report, title: "Report with a screenshot or snapshot of the result" },
    ],
  },
  {
    id: "land",
    purpose: "Bring an open pull request to merge-ready: CI green, threads answered, no conflicts.",
    steps: [
      {
        id: "status",
        title: "Read the PR's checks, review threads and merge state",
        phase: "plan",
      },
      {
        id: "conflicts",
        title: "Merge the base branch and resolve conflicts",
        phase: "implement",
      },
      {
        id: "threads",
        title: "Answer each review thread with a fix or a reason",
        phase: "implement",
      },
      {
        id: "ci",
        title: "Fix each failing check at its cause; never skip or disable it",
        phase: "implement",
      },
      {
        id: "green",
        title: "Watch CI pass on the latest push",
        phase: "verify",
        kinds: ["automated"],
      },
      {
        id: "reread",
        title: "Reread the whole PR diff for leftovers and unrelated changes",
        phase: "review",
        kinds: ["source"],
      },
      {
        id: "ready",
        title: "Report the PR as merge-ready with its checks, or what still holds it",
        phase: "delivery",
      },
    ],
  },
];

/** Every built-in playbook, parsed once so a bad edit fails at load rather than in a result. */
const catalogue = OffshiftPlaybooks.parse({ playbooks });

/** The catalogue `playbooks` returns. */
export function playbookCatalogue(): OffshiftPlaybooks {
  return catalogue;
}

/** One playbook by id. */
export function playbook(id: OffshiftPlaybookId): OffshiftPlaybook {
  const found = catalogue.playbooks.find((item) => item.id === id);
  if (!found) throw new Error(`No built-in playbook ${id}`);
  return found;
}
