import type { Fact } from "@ace/core";
import { facts } from "@ace/fake-daemon";
import type { OpenFilesLimits } from "./changes-files.ts";
import { ChangesKept } from "./changes-kept.ts";
import type { KeptValue } from "./kept-value.ts";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * Test support for the Changes sheet: a thread whose root ran three turns that each edited
 * files with full before and after text, over a checkout with uncommitted changes, on a real
 * SDK client against the fake daemon. A kept value in memory stands in for the phone's.
 */

export const lines = (count: number, label: string) =>
  Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n") + "\n";

const original = lines(20, "line");
const afterOne = original.replace("line 5\n", "line 5 changed\n");
const afterThree = afterOne.replace("line 15\n", "line 15 changed\n");

/** A root turn with its own id that edits `changes` and ends. */
function turn(id: string, changes: { path: string; oldText: string | null; newText: string }[]) {
  return [
    { type: "turn.started", agent: "root", nativeTurnId: id, trigger: "user" },
    facts.message("root", `${id}-ask`, "user", `Do ${id}`),
    facts.tool("root", `${id}-edit`, {
      kind: "file.edit",
      title: `Edit in ${id}`,
      detail: {
        kind: "file.edit",
        changes: changes.map((change) =>
          change.oldText === null
            ? { path: change.path, kind: "add" as const, newText: change.newText }
            : {
                path: change.path,
                kind: "update" as const,
                oldText: change.oldText,
                newText: change.newText,
              },
        ),
      },
    }),
    facts.toolDone("root", `${id}-edit`),
    { type: "turn.ended", agent: "root", nativeTurnId: id, outcome: "completed" },
  ] as Fact[];
}

export const turnEdits = {
  one: [{ path: "src/replay.ts", oldText: original, newText: afterOne }],
  two: [{ path: "src/deep/nested/new.ts", oldText: null, newText: lines(3, "fresh") }],
  three: [{ path: "src/replay.ts", oldText: afterOne, newText: afterThree }],
};

/** A kept value held in memory, like the phone's between launches. */
export function memoryValue(): KeptValue & { held: unknown } {
  const value = {
    held: undefined as unknown,
    async load() {
      return value.held === undefined ? undefined : JSON.parse(JSON.stringify(value.held));
    },
    async save(next: unknown) {
      value.held = JSON.parse(JSON.stringify(next));
    },
  };
  return value;
}

export interface OpenOptions {
  turns?: boolean;
  patch?: string;
  status?: Parameters<ReturnType<typeof sheetFixture>["daemon"]["workspace"]["setGitStatus"]>[1];
  /** What the phone kept, read back by a fresh store as after a relaunch. */
  value?: KeptValue;
  limits?: OpenFilesLimits;
}

export const workingPatch = [
  "diff --git a/src/replay.ts b/src/replay.ts",
  "index 1111111..2222222 100644",
  "--- a/src/replay.ts",
  "+++ b/src/replay.ts",
  "@@ -3,5 +3,5 @@",
  " line 3",
  " line 4",
  "-line 5",
  "+line 5 changed",
  " line 6",
  " line 7",
  "",
].join("\n");

export async function openChanges(options: OpenOptions = {}) {
  const { daemon, client } = sheetFixture();
  daemon.createThread({
    id: "changes",
    workspaceId: "ace",
    title: "Replay window",
    provider: "codex",
    details: {
      branch: "feat/replay",
      worktree: "/fake/worktrees/changes",
      head: "b".repeat(40),
      ahead: 0,
      diff: { files: 1, additions: 1, deletions: 1 },
      repository: { forge: "github", host: "github.com", owner: "arpan404", name: "ace" },
    },
  });
  daemon.apply("changes", [facts.rootAgent("codex")]);
  if (options.turns !== false)
    daemon.apply("changes", [
      ...turn("t1", turnEdits.one),
      ...turn("t2", turnEdits.two),
      ...turn("t3", turnEdits.three),
    ]);
  daemon.workspace.setGitStatus(
    "changes",
    options.status ?? [
      { path: "src/replay.ts", status: "modified", additions: 1, deletions: 1, binary: false },
    ],
  );
  daemon.workspace.setGitDiff("changes", options.patch ?? workingPatch);
  daemon.checkouts.seed("changes", "src/replay.ts", afterOne);
  await client.start();
  const lease = client.thread("changes");
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  if (options.turns !== false) await until(() => lease.store.order.length > 0, "thread items");
  const owner: ChangesOwner = {
    command: (payload) => client.command(payload),
    request: (input) => client.request(input),
  };
  const sink = new RecordingSink();
  const value = options.value ?? memoryValue();
  const kept = new ChangesKept(value);
  let now = 10_000;
  const session = new ChangesSession(owner, lease.store, "changes", 1, sink, plainPreview, {
    kept,
    now: () => (now += 1),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  await until(() => session.reads !== undefined, "first read");
  await until(() => sink.read("changes:review")?.refreshing === false, "review read");
  const close = async () => {
    session.close();
    await client.close();
  };
  return { daemon, client, owner, session, sink, kept, value, close };
}

/** The header patch of an open file, by its path. */
export function fileHeader(sink: RecordingSink, path: string) {
  for (const key of sink.readers.keys())
    if (key.startsWith("changes:file:")) {
      const header = sink.read(key);
      if (header?.path === path) return header;
    }
  return undefined;
}

/** Every page sent for `path`, in order. */
export function filePages(sink: RecordingSink, path: string) {
  const id = fileHeader(sink, path)?.file;
  const pages: Record<string, unknown>[] = [];
  for (let index = 0; ; index++) {
    const page = sink.read(`changes:page:${String(id)}:${index}`);
    if (!page) return pages;
    pages.push(page);
  }
}
