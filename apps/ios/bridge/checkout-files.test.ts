import { until } from "./test-native.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { CheckoutFiles } from "./checkout-files.ts";
import { NativeFilesRequest } from "./checkout-request.ts";

/*
 * The Files screen's requests over the real SDK and an in-process fake daemon: the checkout's
 * tree with its uncommitted changes marked, files read with the web's colours and change marks,
 * saves that never overwrite a newer version, management with Recently deleted, a project's
 * folder read-only, and message links routed to the checkout or the host.
 */

const thread = "ios-files";
const root = "/work/relay";
const outbox = "apps/web/src/relay/outbox.ts";
const patch = [
  `diff --git a/${outbox} b/${outbox}`,
  `--- a/${outbox}`,
  `+++ b/${outbox}`,
  "@@ -3,3 +3,3 @@",
  " ",
  "-/** Old comment. */",
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
  const fake = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "t" });
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

async function connect(fake = daemon()) {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-files-test"),
    expectedHostId: HostId.parse("ios-test-host"),
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
  const files = new CheckoutFiles(owner, async () => ["docs/runbook.md"]);
  const ask = (operation: unknown, scope: unknown = { threadId: thread }) =>
    files.request(
      NativeFilesRequest.parse({ type: "native.files", scope, operation }),
      new AbortController().signal,
    );
  return { fake, ask };
}

test("the tree lists the checkout with each uncommitted change lettered, deleted files too", async () => {
  const { ask } = await connect();
  const tree = await ask({ op: "tree" });
  const rows = tree.rows as { path: string; depth: number; folder: boolean; mark?: string }[];
  expect(rows.find((row) => row.path === outbox)).toMatchObject({ depth: 4, mark: "M" });
  expect(rows.find((row) => row.path === "apps/web/src/relay/legacy.ts")?.mark).toBe("D");
  expect(rows.find((row) => row.path === "README.md")?.mark).toBeUndefined();
  // Folders come before files, and the folders holding a change start open.
  expect(rows[0]).toMatchObject({ path: "apps/", folder: true });
  expect(tree.open).toEqual(["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
});

test("a source file reads with grammar colours spelling its text and its changed lines marked", async () => {
  const { ask } = await connect();
  const file = await ask({ op: "read", path: outbox });
  expect(file).toMatchObject({ ok: true, kind: "text", editable: true, marks: [[4, "modified"]] });
  const runs = file.runs as number[];
  const covered = runs.filter((_, index) => index % 2 === 0).reduce((sum, n) => sum + n, 0);
  expect(covered).toBe(String(file.text).length);
  expect((file.colours as unknown[]).length).toBeGreaterThan(2);
});

test("a binary file and a missing one say so instead of sending text", async () => {
  const { ask } = await connect();
  expect(await ask({ op: "read", path: "apps/web/public/fonts/inter.woff2" })).toMatchObject({
    kind: "binary",
  });
  expect(await ask({ op: "read", path: "gone.ts" })).toMatchObject({ kind: "missing" });
});

test("a save over a file that changed meanwhile names the newer version, and replacing it works", async () => {
  const { ask } = await connect();
  const opened = await ask({ op: "read", path: "README.md" });
  const first = await ask({
    op: "write",
    path: "README.md",
    text: "# phone edit\n",
    expected: opened.version,
  });
  expect(first.version).toEqual(expect.any(String));
  const stale = await ask({
    op: "write",
    path: "README.md",
    text: "# second edit\n",
    expected: opened.version,
  });
  expect(stale.conflict).toBe(first.version);
  await ask({ op: "write", path: "README.md", text: "# second edit\n", expected: stale.conflict });
  expect((await ask({ op: "read", path: "README.md" })).text).toBe("# second edit\n");
});

test("a deleted file goes to Recently deleted and restores from there", async () => {
  const { ask } = await connect();
  await ask({ op: "mkdir", path: "notes" });
  await ask({ op: "create", path: "notes/todo.md" });
  const deleted = await ask({ op: "delete", path: "notes/todo.md" });
  expect(deleted.trashId).toEqual(expect.any(String));
  expect(await ask({ op: "read", path: "notes/todo.md" })).toMatchObject({ kind: "missing" });
  const trash = await ask({ op: "trash" });
  expect(trash.entries).toEqual([expect.objectContaining({ path: "notes/todo.md" })]);
  await ask({ op: "restore", trashId: deleted.trashId, path: "notes/todo.md" });
  expect(await ask({ op: "read", path: "notes/todo.md" })).toMatchObject({ kind: "text" });
});

test("renaming into another folder is refused with the web's sentence; moving works", async () => {
  const { ask } = await connect();
  expect(await ask({ op: "rename", path: "README.md", destination: "docs/README.md" })).toEqual({
    ok: false,
    code: "rename",
    message: "Keep the same folder when renaming. Use Move to change folders.",
  });
  await ask({ op: "mkdir", path: "docs" });
  expect(await ask({ op: "move", path: "README.md", destination: "docs/README.md" })).toMatchObject(
    { ok: true, destination: "docs/README.md" },
  );
});

test("a project's own folder reads but never changes", async () => {
  const { fake, ask } = await connect();
  fake.checkouts.seedProject("ace", "docs/runbook.md", "# Relay runbook\n");
  const project = { workspaceId: "ace" };
  expect(await ask({ op: "read", path: "docs/runbook.md" }, project)).toMatchObject({
    kind: "text",
    editable: false,
  });
  expect((await ask({ op: "search", query: "run" }, project)).rows).toEqual([
    expect.objectContaining({ path: "docs/runbook.md", name: "runbook.md", folder: "docs" }),
  ]);
  expect(await ask({ op: "create", path: "x.md" }, project)).toMatchObject({
    ok: false,
    code: "FORBIDDEN",
  });
});

test("a message's link opens its checkout file at the line, and one outside downloads from the host", async () => {
  const { fake, ask } = await connect();
  const itemId = fake.itemId(thread, "answer") ?? "";
  fake.checkouts.seedLinked(thread, itemId, "/Users/me/Downloads/Study Guide.pdf", "%PDF guide");
  expect(await ask({ op: "link", itemId, reference: `${root}/${outbox}:7` })).toEqual({
    ok: true,
    kind: "checkout",
    path: outbox,
    line: 7,
  });
  const guide = "/Users/me/Downloads/Study Guide.pdf";
  expect(await ask({ op: "link", itemId, reference: guide })).toEqual({
    ok: true,
    kind: "linked",
    name: "Study Guide.pdf",
  });
  const linked = await ask({ op: "linked", itemId, reference: guide });
  expect(Buffer.from(String(linked.data), "base64").toString()).toBe("%PDF guide");
});
