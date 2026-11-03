import { expect, test } from "vitest";
import { WorkspaceId, type ForgeRepository, type ForgeReviewAction } from "@ace/protocol";
import { movingPullRequest } from "./index.ts";
import { FakePrCatalog } from "./pr-catalog-wire.ts";

const workspaceId = WorkspaceId.parse("workspace");
const repository: ForgeRepository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "ace",
};
const number = 250;
const shifted = "packages/ledger/src/streams/account-stream.ts";
const edited = "packages/ledger/src/streams/cursor.ts";
const kept = "packages/ledger/src/streams/order.ts";

function open() {
  const catalog = new FakePrCatalog(() => 5_000_000);
  catalog.add([movingPullRequest(10_000_000)]);
  let commands = 0;
  const pr = { workspaceId, repository, number };
  const review = () => {
    const result = catalog.read({ op: "forge.pr.review-state", ...pr });
    if (result?.resource !== "prReviewState") throw new Error("No review state");
    return result.value;
  };
  const detail = () => {
    const result = catalog.read({ op: "forge.pr.detail", ...pr });
    if (result?.resource !== "prDetail") throw new Error("No detail");
    return result.value;
  };
  const files = (page: number, commit?: string) => {
    const head = detail().status.headSha;
    const result = catalog.read({
      op: "forge.pr.files",
      ...pr,
      page,
      headSha: head,
      baseSha: detail().baseSha,
      ...(commit ? { commit } : {}),
    });
    if (result?.resource !== "prFiles") throw new Error("No files");
    return result.value;
  };
  const send = (action: ForgeReviewAction) =>
    catalog.review(
      { type: "forge.hosted.review", workspaceId, pr: { repository, number }, action },
      `command-${++commands}`,
    );
  return { catalog, review, detail, files, send, push: () => catalog.push(number) };
}

test("the moving PR's files span three pages, each page naming the next", () => {
  const f = open();
  const pages = [f.files(1), f.files(2), f.files(3)];
  expect(pages.map((page) => [page.files.length, page.nextPage])).toEqual([
    [25, 2],
    [25, 3],
    [12, undefined],
  ]);
  const paths = pages.flatMap((page) => page.files.map((file) => file.path));
  expect(new Set(paths).size).toBe(62);
  expect(f.detail().changedFiles).toBe(62);
});

test("conversations an earlier push outdated carry the code and commit they were written on", () => {
  const f = open();
  const head = f.detail().status.headSha;
  const read = f.catalog.read({
    op: "forge.pr.commits",
    workspaceId,
    repository,
    number,
    headSha: head,
  });
  if (read?.resource !== "prCommits") throw new Error("No commits");
  const outdated = f.detail().status.reviewThreads.filter((thread) => thread.outdated);
  expect(outdated).toHaveLength(2);
  for (const thread of outdated) {
    expect(thread.line).toBeNull();
    expect(thread.originalCommit).not.toBe(head);
    expect(read.commits.map((commit) => commit.sha)).toContain(thread.originalCommit);
    const hunk = (thread.hunk ?? "").split("\n");
    expect(hunk[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    // It ends at the commented line, which the later push changed.
    expect(hunk.at(-1)).toMatch(/^\+ {4}(if \(seen\.has|seen\.add)/);
  }
  expect(outdated.map((thread) => thread.originalLine)).toEqual([18, 19]);
});

test("a push makes a new commit: head, review state and commits move; a thread on its edited line goes outdated", () => {
  const f = open();
  const before = f.detail();
  expect(f.push()).toBe(true);
  const after = f.detail();
  expect(after.status.headSha).toMatch(/^[0-9a-f]{40}$/);
  expect(after.status.headSha).not.toBe(before.status.headSha);
  expect(f.review().headSha).toBe(after.status.headSha);
  expect(after.commits).toBe(before.commits + 1);
  // The push's own files: the shifted one and the edited one.
  expect(
    f
      .files(1, after.status.headSha)
      .files.map((file) => file.path)
      .toSorted(),
  ).toEqual([shifted, edited].toSorted());
  const byId = new Map(after.status.reviewThreads.map((thread) => [thread.id, thread]));
  expect(byId.get("RT_2511")).toMatchObject({ outdated: false, line: 19 });
  expect(byId.get("RT_2512")).toMatchObject({
    outdated: true,
    line: null,
    originalLine: 15,
    originalCommit: before.status.headSha,
  });
  expect(byId.get("RT_2512")?.hunk?.split("\n").at(-1)).toContain("const ordered");
  expect(byId.get("RT_2513")).toMatchObject({ outdated: false, line: 20 });
  // Drafts stay where they were written until the client moves them.
  expect(f.review().drafts.every((draft) => draft.anchor.commit === before.status.headSha)).toBe(
    true,
  );
});

test("a draft whose line a push shifted follows it to the new head; one on an untouched file keeps its lines", () => {
  const f = open();
  f.push();
  const head = f.detail().status.headSha;
  expect(f.send({ kind: "drafts.move", headSha: head })).toEqual({ ok: true });
  const drafts = new Map(f.review().drafts.map((draft) => [draft.id, draft]));
  expect(drafts.get("draft-shift")).toEqual({
    id: "draft-shift",
    body: expect.any(String),
    anchor: { commit: head, path: shifted, line: 21, side: "RIGHT" },
  });
  expect(drafts.get("draft-keep")?.anchor).toEqual({
    commit: head,
    path: kept,
    line: 19,
    startLine: 18,
    side: "RIGHT",
  });
});

test("a draft whose line a push edited stays, outdated, and posts on its file", () => {
  const f = open();
  const written = f.review().headSha;
  f.push();
  const head = f.detail().status.headSha;
  f.send({ kind: "drafts.move", headSha: head });
  const draft = f.review().drafts.find((each) => each.id === "draft-edit");
  expect(draft?.anchor).toMatchObject({ commit: written, path: edited, line: 15 });
  expect(draft?.outdated?.headSha).toBe(head);
  expect(draft?.outdated?.code.at(-1)).toContain("const ordered = [...entries].sort");
  expect(f.send({ kind: "draft.file", id: "draft-edit", headSha: head })).toEqual({ ok: true });
  expect(f.review().drafts.map((each) => each.id)).not.toContain("draft-edit");
  const thread = f.detail().status.reviewThreads.at(-1);
  expect(thread).toMatchObject({ file: edited, line: null, outdated: false });
  expect(thread?.comments[0]?.body).toMatch(/^On line 15 at [0-9a-f]{7}:/);
  expect(thread?.comments[0]?.body).toContain("Sort by account first");
});

test("moving drafts or posting one on its file is refused off the current head or for a draft not outdated", () => {
  const f = open();
  const old = f.review().headSha;
  f.push();
  expect(f.send({ kind: "drafts.move", headSha: old })).toEqual({
    ok: false,
    error: "forge_conflict",
  });
  const head = f.detail().status.headSha;
  f.send({ kind: "drafts.move", headSha: head });
  // Moved, not outdated: it posts on its line, not its file.
  expect(f.send({ kind: "draft.file", id: "draft-shift", headSha: head })).toEqual({
    ok: false,
    error: "forge_conflict",
  });
  f.push();
  expect(f.send({ kind: "draft.file", id: "draft-edit", headSha: head })).toEqual({
    ok: false,
    error: "forge_conflict",
  });
});

test("a later push edits the line of a draft that moved to the head before it", () => {
  const f = open();
  f.push();
  f.send({ kind: "drafts.move", headSha: f.detail().status.headSha });
  f.push();
  const head = f.detail().status.headSha;
  f.send({ kind: "drafts.move", headSha: head });
  const drafts = new Map(f.review().drafts.map((draft) => [draft.id, draft]));
  expect(drafts.get("draft-shift")?.anchor).toMatchObject({ commit: head, line: 24 });
  expect(drafts.get("draft-keep")?.outdated?.headSha).toBe(head);
});

test("a reply into the review pending on GitHub counts there instead of showing on the thread", () => {
  const f = open();
  const thread = f.detail().status.reviewThreads.find((each) => each.id === "RT_2511");
  const commentId = thread?.comments[0]?.id ?? 0;
  const reply = (reviewId: string, threadId = "RT_2511") =>
    f.send({ kind: "reply", commentId, body: "Agreed", pendingReview: { reviewId, threadId } });
  expect(reply("PRR_fake")).toEqual({ ok: true });
  expect(f.review().hostedPending).toMatchObject({ id: "PRR_fake", comments: 3 });
  expect(
    f.detail().status.reviewThreads.find((each) => each.id === "RT_2511")?.comments,
  ).toHaveLength(1);
  expect(reply("PRR_other")).toEqual({ ok: false, error: "forge_not_found" });
  expect(reply("PRR_fake", "RT_2512")).toEqual({ ok: false, error: "forge_not_found" });
});

test("submitting is refused while a review is pending on GitHub", () => {
  const f = open();
  const headSha = f.review().headSha;
  expect(
    f.send({ kind: "submit", event: "COMMENT", headSha, body: "", draftIds: ["draft-keep"] }),
  ).toEqual({ ok: false, error: "forge_conflict" });
  expect(f.review().drafts).toHaveLength(3);
});
