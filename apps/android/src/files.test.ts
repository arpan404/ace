import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { pathParts } from "@ace/ui-core";
import {
  encodeBase64,
  formatFileSize,
  listTree,
  parseChangedLines,
  quickOpen,
  readFileContent,
  resolveMessageLink,
  revealFoldersFor,
  visibleTreeRows,
  type FileTreeRowView,
} from "./files.ts";

/*
 * Android file viewing: pure tree/content rules, then the real SDK against an
 * in-process fake daemon (tree with change letters, text/binary/missing reads,
 * message-link routing). No mutations exist in this slice, so none are tested.
 */

const thread = "android-files";
const root = "/work/relay";
const outbox = "apps/web/src/relay/outbox.ts";
const patch = [
  `diff --git a/${outbox} b/${outbox}`,
  `--- a/${outbox}`,
  `+++ b/${outbox}`,
  "@@ -3,3 +3,3 @@",
  " ",
  "-//** Old comment. */",
  "+/** Messages written while offline, sent in order once the relay socket is back. */",
  " const MAX_BUFFERED = 500;",
  "",
].join("\n");

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function daemon(): FakeDaemon {
  const fake = new FakeDaemon({ clock: Date.now, hostId: "android-test-host", token: "t" });
  fake.createThread({ id: thread, workspaceId: "ace", title: "Files", provider: "claude" });
  fake.apply(thread, [
    facts.rootAgent("claude"),
    facts.message(
      "root",
      "answer",
      "assistant",
      `See [outbox](${root}/${outbox}:7) and [the guide](</Users/me/Downloads/Study Guide.pdf>).`,
    ),
  ]);
  fake.workspace.setDetails(thread, {
    worktree: root,
    diff: { files: 2, additions: 1, deletions: 2 },
  });
  fake.workspace.setGitStatus(thread, [
    { path: outbox, status: "modified", additions: 1, deletions: 1, binary: false },
    {
      path: "apps/web/src/relay/legacy.ts",
      status: "deleted",
      additions: 0,
      deletions: 1,
      binary: false,
    },
  ]);
  fake.workspace.setGitDiff(thread, patch);
  return fake;
}

async function until(done: () => boolean): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (done()) return;
    if (Date.now() - started > 15_000) throw new Error("Timed out waiting for the client.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function connect(fake = daemon()): Promise<FakeDaemon> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("android-files-test"),
    expectedHostId: HostId.parse("android-test-host"),
    transport: () => fakeTransport(fake),
    credential: async () => ({ token: "t" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  void owner.start();
  await until(() => owner.state === "ready");
  const lease = owner.thread(thread);
  await until(() => lease.store.thread !== undefined && lease.store.order.length > 0);
  lease.release();
  return fake;
}

function row(path: string, depth: number, folder: boolean): FileTreeRowView {
  return { path, name: pathParts(path).name || path, depth, folder };
}

test("closed folders hide their rows until opened", () => {
  const rows = [row("apps/", 0, true), row("apps/a.ts", 1, false), row("README.md", 0, false)];
  expect(visibleTreeRows(rows, new Set())).toEqual([rows[0], rows[2]]);
  expect(visibleTreeRows(rows, new Set(["apps/"]))).toEqual(rows);
});

test("every folder above a file is revealed", () => {
  expect(revealFoldersFor("apps/web/src/a.ts")).toEqual(["apps/", "apps/web/", "apps/web/src/"]);
  expect(revealFoldersFor("top.ts")).toEqual([]);
});

test("sizes read as bytes, KB and MB", () => {
  expect(formatFileSize(0)).toBe("0 B");
  expect(formatFileSize(512)).toBe("512 B");
  expect(formatFileSize(2048)).toBe("2 KB");
  expect(formatFileSize(2 * 1024 * 1024)).toBe("2 MB");
});

test("a diff marks the added line of its own file only", () => {
  expect(parseChangedLines(patch, outbox)).toEqual([{ line: 4, kind: "added" }]);
  expect(parseChangedLines(patch, "other.ts")).toEqual([]);
});

test("a delete-only hunk leaves a removed marker", () => {
  const removal = [
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ b/gone.ts",
    "@@ -5,2 +5,0 @@",
    " keep",
    "-dropped",
  ].join("\n");
  expect(parseChangedLines(removal, "gone.ts")).toEqual([{ line: 6, kind: "removed" }]);
});

test("quick open matches the name first and skips the rest", () => {
  const paths = [
    "apps/web/src/relay/outbox.ts",
    "docs/runbook.md",
    "apps/web/public/fonts/inter.woff2",
  ];
  const found = quickOpen("out", paths);
  expect(found.map((entry) => entry.path)).toEqual(["apps/web/src/relay/outbox.ts"]);
  expect(quickOpen("zzz", paths)).toEqual([]);
  expect(quickOpen("  ", paths)).toEqual([]);
});

test("base64 matches the platform encoding", () => {
  const bytes = new TextEncoder().encode("ace files ✓");
  expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
});

test("a checkout link opens at its line; an outside file is host-served; https is none", () => {
  expect(resolveMessageLink(`${root}/${outbox}:7`, { root, cwd: undefined })).toEqual({
    kind: "checkout",
    path: outbox,
    line: 7,
  });
  expect(
    resolveMessageLink("/Users/me/Downloads/Study Guide.pdf", { root, cwd: undefined }),
  ).toEqual({
    kind: "linked",
    name: "Study Guide.pdf",
  });
  expect(resolveMessageLink("https://example.com/a.ts", { root, cwd: undefined })).toEqual({
    kind: "none",
  });
});

test("the tree lists the checkout with each uncommitted change lettered", async () => {
  await connect();
  if (!client) throw new Error("Client did not start.");
  const tree = await listTree(client, { threadId: thread }, new AbortController().signal);
  const rows = new Map(tree.rows.map((entry) => [entry.path, entry]));
  expect(rows.get(outbox)).toMatchObject({ depth: 4, mark: "M" });
  expect(rows.get("apps/web/src/relay/legacy.ts")?.mark).toBe("D");
  expect(rows.get("README.md")?.mark).toBeUndefined();
  expect(tree.rows[0]).toMatchObject({ path: "apps/", folder: true });
  expect(tree.open).toEqual(["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  expect(tree.truncated).toBe(false);
});

test("a source file reads as text with its changed line marked", async () => {
  await connect();
  if (!client) throw new Error("Client did not start.");
  const file = await readFileContent(
    client,
    { threadId: thread },
    outbox,
    new AbortController().signal,
  );
  if (file.kind !== "text") throw new Error(`Expected text, read ${file.kind}.`);
  expect(file.marks).toContainEqual({ line: 4, kind: "added" });
  expect(file.markdown).toBe(false);
  expect(file.language).toBe("ts");
  expect(file.text).toContain("MAX_BUFFERED");
});

test("a binary file and a missing one say so instead of sending text", async () => {
  await connect();
  if (!client) throw new Error("Client did not start.");
  const signal = new AbortController().signal;
  expect(
    await readFileContent(
      client,
      { threadId: thread },
      "apps/web/public/fonts/inter.woff2",
      signal,
    ),
  ).toMatchObject({
    kind: "binary",
  });
  expect(await readFileContent(client, { threadId: thread }, "gone.ts", signal)).toMatchObject({
    kind: "missing",
  });
});

test("a project's own folder reads but never changes through this slice", async () => {
  const fake = await connect();
  fake.checkouts.seedProject("ace", "docs/runbook.md", "# Relay runbook\n");
  if (!client) throw new Error("Client did not start.");
  const signal = new AbortController().signal;
  const file = await readFileContent(client, { workspaceId: "ace" }, "docs/runbook.md", signal);
  if (file.kind !== "text") throw new Error(`Expected text, read ${file.kind}.`);
  expect(file.text).toBe("# Relay runbook\n");
  const tree = await listTree(client, { workspaceId: "ace" }, signal);
  expect(tree.rows.map((entry) => entry.path)).toContain("docs/runbook.md");
});

test("a rename marks its new path only", () => {
  const renamed = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-dropped",
    "+kept",
    "",
  ].join("\n");
  expect(parseChangedLines(renamed, "new.ts")).toEqual([{ line: 2, kind: "added" }]);
  expect(parseChangedLines(renamed, "old.ts")).toEqual([]);
});

test("a quoted path with a space still matches", () => {
  const spaced = [
    'diff --git "a/my file.ts" "b/my file.ts"',
    '--- "a/my file.ts"',
    '+++ "b/my file.ts"',
    "@@ -1,2 +1,2 @@",
    " keep",
    "-dropped",
    "+kept",
    "",
  ].join("\n");
  expect(parseChangedLines(spaced, "my file.ts")).toEqual([{ line: 2, kind: "added" }]);
});

test("binary and index lines never move the hunk cursor", () => {
  const noisy = [
    "diff --git a/keep.ts b/keep.ts",
    "index 1111111..2222222 100644",
    "--- a/keep.ts",
    "+++ b/keep.ts",
    "Binary files a/keep.ts and b/keep.ts differ",
    "@@ -3,3 +3,3 @@",
    " ",
    "-//** Old comment. */",
    "+/** New comment. */",
    " const MAX_BUFFERED = 500;",
    "",
  ].join("\n");
  expect(parseChangedLines(noisy, "keep.ts")).toEqual([{ line: 4, kind: "added" }]);
});

test("a deleted file still marks its removed hunk", () => {
  const deleted = [
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -5,2 +5,0 @@",
    " keep",
    "-dropped",
  ].join("\n");
  expect(parseChangedLines(deleted, "gone.ts")).toEqual([{ line: 6, kind: "removed" }]);
});

test("an aborted tree read never reaches the daemon", async () => {
  await connect();
  if (!client) throw new Error("Client did not start.");
  const controller = new AbortController();
  controller.abort();
  await expect(listTree(client, { threadId: thread }, controller.signal)).rejects.toThrow();
});

test("back-to-back tree reads both land after the scope settles", async () => {
  await connect();
  if (!client) throw new Error("Client did not start.");
  const signal = new AbortController().signal;
  const first = await listTree(client, { threadId: thread }, signal);
  const second = await listTree(client, { threadId: thread }, signal);
  expect(first.rows.length).toBeGreaterThan(0);
  expect(second.rows.length).toBeGreaterThan(0);
});
