import type { Fact } from "@ace/core";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { GitStatusFile } from "@ace/protocol";
import { diffTexts, type DiffLine } from "@ace/ui-core";

/*
 * The spike's `ios-changes` thread for the Changes sheet's scopes, review and paging: a root
 * that ran three turns, each editing files with full before and after text (so Last turn, each
 * Turn N and This thread diff on the phone), over a checkout with uncommitted changes in about
 * forty files across nested folders and one generated file of 22,000 added lines (its diff is
 * cut from the checkout's patch and read alone, page by page). The checkout holds each changed
 * file's text, so review comments are checked and suggestions apply. No provider CLI runs.
 */

export const changesThread = "ios-changes";
const root = "/tmp/ace-ios-spike/worktrees/ios-changes";
const text = (lines: readonly string[]) => `${lines.join("\n")}\n`;

const windowBefore = text([
  'import type { Event } from "@ace/protocol";',
  "",
  "/** The events a client replays after a reconnect. */",
  "export function replayWindow(events: readonly Event[], from: number): Event[] {",
  "  const out: Event[] = [];",
  "  for (const event of events) {",
  "    if (event.seq > from) out.push(event);",
  "  }",
  "  return out;",
  "}",
  ...Array.from({ length: 30 }, (_, i) => `// replay note ${i + 1}`),
]);
const windowTurn1 = windowBefore
  .replace(
    "  const out: Event[] = [];",
    "  const out: Event[] = [];\n  if (from === 0) return events.slice(-200);",
  )
  .replace("// replay note 12", "// replay note 12: a cold start replays at most 200 events");
const windowTurn2 = windowTurn1.replace(
  "    if (event.seq > from) out.push(event);",
  "    if (event.seq > from && !event.ephemeral) out.push(event);",
);
const cursor = text([
  "/** Where a client's replay resumes. */",
  "export interface ReplayCursor {",
  "  seq: number;",
  "  epoch: string;",
  "}",
]);
const protocolBefore = text(["export const ReplayLimit = 100;", "export const ReplayChunk = 50;"]);
const protocolTurn2 = text(["export const ReplayLimit = 200;", "export const ReplayChunk = 50;"]);
const windowTest = text([
  'import { expect, test } from "vitest";',
  'import { replayWindow } from "./window.ts";',
  "",
  'test("a cold start replays at most the last 200 events", () => {',
  "  const events = Array.from({ length: 500 }, (_, seq) => ({ seq }));",
  "  expect(replayWindow(events as never, 0)).toHaveLength(200);",
  "});",
]);
const legacy = text(["export const legacyReplay = true;"]);

type Change =
  | { path: string; kind: "update"; oldText: string; newText: string }
  | { path: string; kind: "add"; newText: string }
  | { path: string; kind: "delete"; oldText: string };

function editTurn(id: string, ask: string, answer: string, changes: Change[]): Fact[] {
  return [
    { type: "turn.started", agent: "root", nativeTurnId: id, trigger: "user" },
    facts.message("root", `${id}-ask`, "user", ask),
    ...changes.flatMap((change, index): Fact[] => [
      facts.tool("root", `${id}-edit-${index}`, {
        kind: "file.edit",
        title: `Edit ${change.path}`,
        detail: { kind: "file.edit", changes: [change] },
      }),
      facts.toolDone("root", `${id}-edit-${index}`),
    ]),
    facts.message("root", `${id}-answer`, "assistant", answer),
    { type: "turn.ended", agent: "root", nativeTurnId: id, outcome: "completed" },
  ];
}

/** A `git diff` section for one file from its two texts, hunks with three lines of context. */
function section(path: string, before: string | null, after: string | null): string {
  const lines = diffTexts(before ?? "", after ?? "");
  const head = [
    `diff --git a/${path} b/${path}`,
    ...(before === null
      ? ["new file mode 100644"]
      : after === null
        ? ["deleted file mode 100644"]
        : []),
    `--- ${before === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
  ];
  const changed = lines.flatMap((line, index) => (line.kind === "context" ? [] : [index]));
  const hunks: DiffLine[][] = [];
  let current: DiffLine[] = [];
  let last = -10;
  for (const index of changed) {
    const from = Math.max(0, index - 3);
    if (index - last > 7 && current.length) {
      current.push(...lines.slice(last + 1, Math.min(lines.length, last + 4)));
      hunks.push(current);
      current = [];
    }
    current.push(...lines.slice(current.length ? last + 1 : from, index + 1));
    last = index;
  }
  if (current.length) {
    current.push(...lines.slice(last + 1, Math.min(lines.length, last + 4)));
    hunks.push(current);
  }
  const body: string[] = [];
  for (const hunk of hunks) {
    const olds = hunk.filter((line) => line.kind !== "add");
    const news = hunk.filter((line) => line.kind !== "del");
    body.push(`@@ -${olds[0]?.old ?? 0},${olds.length} +${news[0]?.new ?? 0},${news.length} @@`);
    for (const line of hunk)
      body.push(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
  }
  return [...head, ...body].join("\n");
}

interface CheckoutFile {
  path: string;
  before: string | null;
  after: string | null;
}

/** About forty small files across nested folders, each with one line changed or added. */
function spread(): CheckoutFile[] {
  const folders = [
    "apps/server/src/replay/cache",
    "apps/server/src/replay/cursor",
    "apps/server/src/sockets",
    "apps/web/src/features/thread/replay",
    "packages/client/src/replay",
    "packages/protocol/src/replay/v2",
    "docs/adr",
  ];
  return folders.flatMap((folder, f) =>
    Array.from({ length: f === 6 ? 2 : 6 }, (_, i): CheckoutFile => {
      const name = folder === "docs/adr" ? `00${90 + i}-replay-${i}.md` : `part-${i + 1}.ts`;
      const lines = Array.from(
        { length: 12 },
        (_line, n) => `// ${folder} part ${i + 1}, line ${n + 1}`,
      );
      const before = text(lines);
      const after = text(lines.map((line, n) => (n === 5 ? `${line} (replay window)` : line)));
      return i === 5
        ? { path: `${folder}/${name}`, before: null, after }
        : { path: `${folder}/${name}`, before, after };
    }),
  );
}

const hugePath = "data/fixtures/replay-events.jsonl";
const huge = text(
  Array.from(
    { length: 22_000 },
    (_, i) => `{"seq":${i + 1},"type":"item.delta","text":"replayed chunk ${i + 1}"}`,
  ),
);

function statusOf(file: CheckoutFile): GitStatusFile {
  const lines = diffTexts(file.before ?? "", file.after ?? "");
  return {
    path: file.path,
    status: file.before === null ? "added" : file.after === null ? "deleted" : "modified",
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "del").length,
    binary: false,
  };
}

export function seedChanges(
  daemon: FakeDaemon,
  details: (branch: string) => NonNullable<Parameters<FakeDaemon["createThread"]>[0]["details"]>,
): void {
  daemon.createThread({
    hasSentMessage: true,
    id: changesThread,
    workspaceId: "ace",
    title: "Cap the replay window",
    provider: "codex",
    details: details("feat/replay-window"),
  });
  daemon.apply(changesThread, [
    facts.rootAgent("codex"),
    ...editTurn(
      "t1",
      "Replay at most 200 events on a cold start.",
      "A cold start now replays the last 200 events, and the cursor has its own type.",
      [
        {
          path: "apps/server/src/replay/window.ts",
          kind: "update",
          oldText: windowBefore,
          newText: windowTurn1,
        },
        { path: "apps/server/src/replay/cursor.ts", kind: "add", newText: cursor },
      ],
    ),
    ...editTurn(
      "t2",
      "Skip ephemeral events and raise the protocol limit.",
      "Ephemeral events no longer replay, and the protocol limit is 200.",
      [
        {
          path: "apps/server/src/replay/window.ts",
          kind: "update",
          oldText: windowTurn1,
          newText: windowTurn2,
        },
        {
          path: "packages/protocol/src/replay.ts",
          kind: "update",
          oldText: protocolBefore,
          newText: protocolTurn2,
        },
      ],
    ),
    ...editTurn(
      "t3",
      "Add a test and remove the legacy replay.",
      "Added the cold-start test and deleted the legacy replay.",
      [
        { path: "apps/server/src/replay/window.test.ts", kind: "add", newText: windowTest },
        { path: "apps/server/src/replay/legacy.ts", kind: "delete", oldText: legacy },
      ],
    ),
  ]);
  const files: CheckoutFile[] = [
    { path: "apps/server/src/replay/window.ts", before: windowBefore, after: windowTurn2 },
    { path: "apps/server/src/replay/cursor.ts", before: null, after: cursor },
    { path: "apps/server/src/replay/window.test.ts", before: null, after: windowTest },
    { path: "apps/server/src/replay/legacy.ts", before: legacy, after: null },
    { path: "packages/protocol/src/replay.ts", before: protocolBefore, after: protocolTurn2 },
    ...spread(),
  ];
  for (const file of files)
    if (file.after !== null) daemon.checkouts.seed(changesThread, file.path, file.after);
  const status = [
    ...files.map(statusOf),
    { path: hugePath, status: "added" as const, additions: 22_000, deletions: 0, binary: false },
  ];
  daemon.workspace.setDetails(changesThread, {
    worktree: root,
    head: "5".repeat(40),
    ahead: 0,
    behind: 0,
    diff: {
      files: status.length,
      additions: status.reduce((sum, file) => sum + file.additions, 0),
      deletions: status.reduce((sum, file) => sum + file.deletions, 0),
    },
    repository: { forge: "github", host: "github.com", owner: "arpan404", name: "ace" },
  });
  daemon.workspace.setGitStatus(changesThread, status);
  // The generated file sorts last, so the checkout's 256 KiB patch is cut inside it.
  daemon.workspace.setGitDiff(
    changesThread,
    `${[...files.map((file) => section(file.path, file.before, file.after)), section(hugePath, null, huge)].join("\n")}\n`,
  );
}
