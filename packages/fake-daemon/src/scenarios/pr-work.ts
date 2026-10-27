import { ThreadId, type ForgeCheckRun, type GitConflictFile } from "@ace/protocol";
import type { FakeDaemon } from "../daemon.ts";

/*
 * Work a pull request page starts, on top of `seedForgeBrowse`'s `acme/ace` catalog:
 * - #229's checks are GitHub Actions jobs with runs to open: `test (web)` failed with a long
 *   log, annotations and steps; `e2e (ios)` is still running.
 * - #226 is worked on by the thread `pr-work-226`, whose checkout of it conflicts with main in
 *   two files; #224 and #226 form a stack that checkout holds.
 * - #212 is merged and can be reverted (the catalog's own).
 */

export const prWorkThread = ThreadId.parse("pr-work-226");
const head = (number: number) => number.toString(16).padStart(40, "e");
const url = (number: number) => `https://github.com/acme/ace/pull/${number}`;

/** A failing test job's log: setup, a long run of passing tests, then the failure. */
function failingLog(): { text: string; errors: number[]; focus: number } {
  const lines = ["Run actions/checkout@v5", "Syncing repository: acme/ace", "Run bun install"];
  for (let i = 1; i <= 1_400; i++) lines.push(`✓ apps/web/src/case-${i}.test.tsx (${i % 40} ms)`);
  const focus = lines.length;
  lines.push(
    "Run bun run test",
    "FAIL apps/web/src/features/thread/composer/toolbar.test.tsx",
    "Error: expected the model chip to stay in the toolbar",
    "    at toolbar.test.tsx:42:7",
    "Tests  1 failed | 1400 passed",
  );
  return { text: lines.join("\n"), errors: [focus + 2], focus };
}

const run = (id: number, name: string, patch: Partial<ForgeCheckRun>): ForgeCheckRun => ({
  id,
  name,
  status: "success",
  conclusion: "success",
  url: `https://github.com/acme/ace/actions/runs/90${id}/job/${id}`,
  output: { title: null, summary: null, text: null },
  workflow: { runId: 9_000 + id, attempt: 1, jobId: id, steps: [] },
  log: { text: `Run ${name}\nDone`, truncated: false, errors: [], focus: null },
  logUnavailable: false,
  annotations: [],
  annotationsTruncated: false,
  ...patch,
});

function seedChecks(daemon: FakeDaemon, now: number): void {
  const log = failingLog();
  const runs: ForgeCheckRun[] = [
    run(2291, "lint", {}),
    run(2292, "typecheck", {}),
    run(2293, "test (web)", {
      status: "failure",
      conclusion: "failure",
      output: { title: "1 failing test", summary: "toolbar.test.tsx failed.", text: null },
      workflow: {
        runId: 9_229,
        attempt: 1,
        jobId: 2293,
        steps: [
          { number: 1, name: "Set up job", status: "success", line: 0 },
          { number: 2, name: "Install", status: "success", line: 2 },
          { number: 3, name: "Test", status: "failure", line: log.focus },
        ],
      },
      log: { text: log.text, truncated: false, errors: log.errors, focus: log.focus },
      annotations: [
        {
          path: "apps/web/src/features/thread/composer/toolbar.test.tsx",
          startLine: 42,
          endLine: 42,
          level: "failure",
          title: "toolbar keeps the model chip",
          message: "expected the model chip to stay in the toolbar",
        },
      ],
    }),
    run(2294, "e2e (ios)", {
      status: "pending",
      conclusion: null,
      workflow: { runId: 9_230, attempt: 1, jobId: 2294, steps: [] },
      log: null,
    }),
  ];
  for (const each of runs) daemon.workspace.prWork.seedCheckRun(each);
  daemon.workspace.patchPullRequest(229, (fixture) => ({
    ...fixture,
    detail: {
      ...fixture.detail,
      status: {
        ...fixture.detail.status,
        checks: runs.map((each) => ({
          id: `check:${each.id}`,
          name: each.name,
          status: each.status,
          conclusion: each.conclusion,
          completedAt: each.status === "pending" ? null : new Date(now).toISOString(),
          jobId: each.workflow?.jobId ?? null,
          url: each.url,
        })),
      },
    },
  }));
}

const marker = {
  ours: "<<<<<<< HEAD\n",
  base: null,
  separator: "=======\n",
  theirs: ">>>>>>> main\n",
};
const conflicted: GitConflictFile[] = [
  {
    path: "apps/web/src/features/thread/composer/toolbar.tsx",
    stages: { base: true, ours: true, theirs: true },
    content: {
      kind: "text",
      revision: "a".repeat(64),
      segments: [
        { kind: "text", text: 'import { ModelChip } from "./model-chip.tsx";\n\n' },
        {
          kind: "conflict",
          ours: "export function Toolbar() {\n  return <ModelChip compact />;\n",
          base: null,
          theirs:
            "export function Toolbar(props: { compact: boolean }) {\n  return <ModelChip compact={props.compact} />;\n",
          markers: marker,
        },
        { kind: "text", text: "}\n" },
      ],
    },
  },
  {
    path: "apps/web/src/features/thread/composer/composer.tsx",
    stages: { base: true, ours: true, theirs: true },
    content: {
      kind: "text",
      revision: "b".repeat(64),
      segments: [
        {
          kind: "conflict",
          ours: 'import { Toolbar } from "./toolbar.tsx";\n',
          base: null,
          theirs: 'import { Toolbar } from "./composer-toolbar.tsx";\n',
          markers: marker,
        },
        { kind: "text", text: "\nexport function Composer() {}\n" },
      ],
    },
  },
  {
    path: "apps/web/public/toolbar.png",
    stages: { base: true, ours: true, theirs: true },
    content: { kind: "unavailable", reason: "binary" },
  },
];

function seedStack(daemon: FakeDaemon): void {
  const layer = (number: number, position: number, branch: string, base: string) => ({
    number,
    position,
    title:
      number === 224
        ? "Retry provider logins once on a 502"
        : "Split the composer toolbar into its own module",
    url: url(number),
    headSha: head(number),
    branch,
    baseBranch: base,
    state: "OPEN",
    mergeState: "CLEAN",
    reviewDecision: "APPROVED",
    checksState: "SUCCESS",
    requiredChecks: [],
    checksTruncated: false,
    queueState: null,
  });
  daemon.workspace.prWork.seedStack({
    stack: {
      id: "stack-composer",
      number: 4,
      trunk: "main",
      layers: [
        layer(224, 1, "fix/login-retry", "main"),
        layer(226, 2, "refactor/composer-toolbar", "fix/login-retry"),
      ],
      canMerge: true,
      raw: {},
    },
    local: {
      trunk: "main",
      currentBranch: "refactor/composer-toolbar",
      branches: [
        {
          name: "fix/login-retry",
          head: head(224),
          base: "f".repeat(40),
          isCurrent: false,
          isMerged: false,
          isQueued: false,
          needsRebase: true,
          pr: { number: 224, url: url(224), state: "OPEN" },
        },
        {
          name: "refactor/composer-toolbar",
          head: head(226),
          base: head(224),
          isCurrent: true,
          isMerged: false,
          isQueued: false,
          needsRebase: false,
          pr: { number: 226, url: url(226), state: "OPEN" },
        },
      ],
    },
    localUnavailable: null,
    operation: null,
    movedLayers: [],
  });
}

export function seedPrWork(daemon: FakeDaemon, now: number, project = "ace"): void {
  seedChecks(daemon, now);
  daemon.createThread({
    id: prWorkThread,
    workspaceId: project,
    title: "Split the composer toolbar",
    provider: "codex",
    hasSentMessage: true,
    details: { branch: "refactor/composer-toolbar", head: head(226) },
  });
  daemon.workspace.linkPullRequest(226, { id: prWorkThread, title: "Split the composer toolbar" });
  daemon.workspace.conflicts.seed(prWorkThread, head(226), conflicted);
  seedStack(daemon);
}
