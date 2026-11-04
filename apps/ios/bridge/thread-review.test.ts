import type { ThreadDetails, ThreadStatus } from "@ace/protocol";
import type { ReviewDraft } from "@ace/ui-core/review";
import { afterEach, describe, expect, test } from "vitest";
import { changesAction, ChangesAction } from "./changes-actions.ts";
import { openChanges } from "./changes-fixture.ts";
import { plainPreview, until } from "./sheet-fixture.ts";
import { commentChip, reviewReady, ThreadReview } from "./thread-review.ts";

const done: ThreadStatus = { state: "done" };
const changed: ThreadDetails = {
  branch: "ace/remote",
  diff: { files: 9, additions: 214, deletions: 61 },
};

describe("ready to review", () => {
  test("a finished tree with changes reads files, lines and the branch", () => {
    expect(reviewReady(done, changed)).toMatchObject({
      line: "9 files · +214 −61",
      branch: "ace/remote",
      pr: null,
    });
  });

  test.each<[string, ThreadStatus]>([
    ["the root still works", { state: "working", agents: 1 }],
    ["a subagent asks the person", { state: "needs_you", interactions: 1 }],
    ["background work still runs", { state: "waiting", on: "background_task" }],
    ["the turn is held at a usage limit", { state: "limited" }],
    ["the turn failed", { state: "failed" }],
  ])("nothing shows while %s", (_, status) => {
    expect(reviewReady(status, changed)).toBeUndefined();
  });

  test("nothing shows when the checkout holds no changes, or for a chat", () => {
    expect(reviewReady(done, { diff: { files: 0, additions: 0, deletions: 0 } })).toBeUndefined();
    expect(reviewReady(done, {})).toBeUndefined();
    expect(
      reviewReady(done, {
        ...changed,
        workspace: { id: "c", name: "Chat", path: "/c", kind: "chat" },
      }),
    ).toBeUndefined();
  });

  test("the pull request's checks join the line only when the forge reported them", () => {
    const pr = {
      number: 12,
      repo: { forge: "github" as const, host: "github.com", owner: "a", name: "b" },
      url: "https://github.com/a/b/pull/12",
      state: "open" as const,
      updatedAt: 1,
    };
    expect(
      reviewReady(done, { ...changed, linkedPrs: [{ ...pr, checks: "passed" }] }),
    ).toMatchObject({
      line: "9 files · +214 −61 · checks passed",
      pr: { number: 12, state: "open" },
    });
    expect(reviewReady(done, { ...changed, linkedPrs: [pr] })?.line).toBe("9 files · +214 −61");
  });
});

const draft = (over: Partial<ReviewDraft>): ReviewDraft => ({
  key: `k${over.createdAt ?? 0}`,
  threadId: "t",
  file: "fleet-map/wires.ts",
  side: "new",
  line: 44,
  text: "Why fall back to the index here?",
  state: "draft",
  createdAt: 1,
  ...over,
});

describe("comment chip", () => {
  test("unsent comments on one file name the file", () => {
    expect(commentChip([draft({ createdAt: 1 })], "t")?.label).toBe("1 comment on wires.ts");
    expect(
      commentChip([draft({ createdAt: 1 }), draft({ createdAt: 2, state: "failed" })], "t")?.label,
    ).toBe("2 comments on wires.ts");
  });

  test("comments on several files count the files", () => {
    const chip = commentChip(
      [draft({ createdAt: 1 }), draft({ createdAt: 2, file: "fleet-map/zones.ts" })],
      "t",
    );
    expect(chip).toEqual({ count: 2, label: "2 comments on 2 files", path: "fleet-map/zones.ts" });
  });

  test("sent comments and other threads' comments stay off the chip", () => {
    expect(
      commentChip([draft({ state: "sent" }), draft({ threadId: "other", createdAt: 3 })], "t"),
    ).toBeUndefined();
  });
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("sending from the composer chip", () => {
  test("the chip's comments reach the agent through the review and the chip empties", async () => {
    const sheet = await openChanges();
    closers.push(sheet.close);
    sheet.session.scope("working-tree");
    sheet.session.open("src/replay.ts", true);
    const comment = ChangesAction.parse({
      kind: "review.draft",
      requestId: "d1",
      path: "src/replay.ts",
      side: "new",
      start: 5,
      end: 5,
      text: "Why change this?",
    });
    await until(() => {
      changesAction(sheet.session, comment, sheet.sink, plainPreview);
      return sheet.sink.read("changes:notice")?.ok === true;
    }, "draft saved");
    const review = new ThreadReview({
      owner: sheet.owner,
      store: sheet.client.thread("changes").store,
      threadId: "changes",
      epoch: 1,
      kept: sheet.kept,
      sink: sheet.sink,
      preview: plainPreview,
      id: (() => {
        let at = 0;
        return () => `chip-${++at}`;
      })(),
    });
    closers.push(async () => review.stop());
    expect(sheet.sink.read("changes:chip")?.chip).toMatchObject({
      count: 1,
      label: "1 comment on replay.ts",
    });
    review.send("s1");
    await until(() => sheet.sink.read("changes:notice")?.requestId === "s1", "sent");
    expect(sheet.sink.read("changes:notice")).toMatchObject({ ok: true });
    expect(sheet.sink.read("changes:chip")?.chip).toBeNull();
    expect(sheet.kept.get()).toEqual([expect.objectContaining({ state: "sent" })]);
  });
});
