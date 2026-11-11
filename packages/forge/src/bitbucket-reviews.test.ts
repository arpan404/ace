import { expect, test } from "vitest";
import type { ForgeReviewAction } from "@ace/protocol/forge-review";
import { BitbucketReviews, bitbucketWriteMarker, reviewId } from "./bitbucket-reviews.ts";
import { WriteDispatch } from "./write-dispatch.ts";
import {
  author,
  bitbucketHost,
  head,
  me,
  pullRequest,
  repository,
  root,
  type WriteReply,
} from "./testing/bitbucket-host.ts";

const signal = new AbortController().signal;
const pr = `${root}/pullrequests/7`;
function reviews(
  options: {
    replies?: Record<string, unknown>;
    write?: (w: { endpoint: string }) => WriteReply;
  } = {},
) {
  const host = bitbucketHost(options);
  return {
    host,
    reviews: new BitbucketReviews({ repository, runner: host.runner, login: "work" }),
  };
}
const send = (r: BitbucketReviews, action: ForgeReviewAction, dispatch?: WriteDispatch) =>
  r.write(7, action, [], "op-1", signal, () => true, dispatch);
const anchor = { commit: head, path: "src/a.ts", line: 12, side: "RIGHT" as const };
const marker = bitbucketWriteMarker("op-1");

test("each review write sends exactly one request in Bitbucket's documented shape", async () => {
  const cases: [ForgeReviewAction, string, string, unknown][] = [
    [
      { kind: "conversation", body: "Looks good" },
      "POST",
      `${pr}/comments`,
      { content: { raw: `Looks good\n\n${marker}` } },
    ],
    [
      { kind: "line.comment", headSha: head, anchor, body: "Rename" },
      "POST",
      `${pr}/comments`,
      { content: { raw: `Rename\n\n${marker}` }, inline: { path: "src/a.ts", to: 12 } },
    ],
    [
      { kind: "line.comment", headSha: head, anchor: { ...anchor, side: "LEFT" }, body: "Old" },
      "POST",
      `${pr}/comments`,
      { content: { raw: `Old\n\n${marker}` }, inline: { path: "src/a.ts", from: 12 } },
    ],
    [
      { kind: "submit", headSha: head, event: "APPROVE", body: "", draftIds: [] },
      "POST",
      `${pr}/approve`,
      undefined,
    ],
    [
      { kind: "submit", headSha: head, event: "REQUEST_CHANGES", body: "", draftIds: [] },
      "POST",
      `${pr}/request-changes`,
      undefined,
    ],
  ];
  for (const [action, method, endpoint, body] of cases) {
    const { host, reviews: r } = reviews();
    await send(r, action);
    expect(host.writes).toEqual([{ method, endpoint, body }]);
  }
});

test("a reply names its parent comment, and a comment from another pull request is never replied to", async () => {
  const comments = {
    [`${pr}/comments?pagelen=100`]: {
      values: [{ id: 5, content: { raw: "Why?" }, user: author, created_on: "2026-11-02" }],
    },
  };
  const { host, reviews: r } = reviews({ replies: comments });
  await send(r, { kind: "reply", commentId: 5, body: "Because" });
  expect(host.writes).toEqual([
    {
      method: "POST",
      endpoint: `${pr}/comments`,
      body: { content: { raw: `Because\n\n${marker}` }, parent: { id: 5 } },
    },
  ]);
  const other = reviews({ replies: comments });
  await expect(
    send(other.reviews, { kind: "reply", commentId: 6, body: "x" }),
  ).rejects.toMatchObject({ kind: "not_found" });
  expect(other.host.writes).toEqual([]);
});

test.each<[string, ForgeReviewAction, Record<string, unknown>, string]>([
  [
    "a moved head",
    {
      kind: "line.comment",
      headSha: "c".repeat(40),
      anchor: { ...anchor, commit: "c".repeat(40) },
      body: "x",
    },
    {},
    "head_moved",
  ],
  [
    "an approval with text Bitbucket can't carry",
    { kind: "submit", headSha: head, event: "APPROVE", body: "LGTM", draftIds: [] },
    {},
    "unsupported",
  ],
  [
    "a multi-line comment",
    { kind: "line.comment", headSha: head, anchor: { ...anchor, startLine: 10 }, body: "x" },
    {},
    "unsupported",
  ],
  [
    "approving one's own pull request",
    { kind: "submit", headSha: head, event: "APPROVE", body: "", draftIds: [] },
    { [pr]: pullRequest({ author: me }) },
    "forbidden",
  ],
  [
    "a declined pull request",
    { kind: "conversation", body: "x" },
    { [pr]: pullRequest({ state: "DECLINED" }) },
    "forbidden",
  ],
  [
    "a thread resolve, which isn't offered",
    { kind: "thread.resolve", threadId: "5" },
    {},
    "unsupported",
  ],
  [
    "asking for reviewers, which isn't offered",
    { kind: "reviewers.request", reviewers: ["bob"] },
    {},
    "unsupported",
  ],
])("nothing is sent for %s", async (_name, action, replies, kind) => {
  const { host, reviews: r } = reviews({ replies });
  await expect(send(r, action)).rejects.toMatchObject({ kind });
  expect(host.writes).toEqual([]);
});

test("withdrawing a verdict removes only the viewer's own approval or requested changes", async () => {
  const withVerdict = (state: string | null, approved: boolean) => ({
    [pr]: pullRequest({ participants: [{ user: me, role: "REVIEWER", approved, state }] }),
  });
  const approved = reviews({ replies: withVerdict("approved", true) });
  await send(approved.reviews, {
    kind: "review.dismiss",
    reviewId: reviewId(me.uuid),
    message: "oops",
  });
  expect(approved.host.writes).toEqual([
    { method: "DELETE", endpoint: `${pr}/approve`, body: undefined },
  ]);
  const changes = reviews({ replies: withVerdict("changes_requested", false) });
  await send(changes.reviews, {
    kind: "review.dismiss",
    reviewId: reviewId(me.uuid),
    message: "ok",
  });
  expect(changes.host.writes).toEqual([
    { method: "DELETE", endpoint: `${pr}/request-changes`, body: undefined },
  ]);
  const someone = reviews({ replies: withVerdict("approved", true) });
  await expect(
    send(someone.reviews, {
      kind: "review.dismiss",
      reviewId: reviewId(author.uuid),
      message: "no",
    }),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect(someone.host.writes).toEqual([]);
});

test("an explicit refusal definitely failed; a lost reply or a server error is uncertain", async () => {
  const action: ForgeReviewAction = { kind: "conversation", body: "x" };
  const refused = new WriteDispatch();
  await expect(
    send(reviews({ write: () => ({ status: 403 }) }).reviews, action, refused),
  ).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(refused.definitelyFailed).toBe(true);
  for (const reply of [
    { lost: true as const },
    { status: 500 },
    { status: 200, identityChanged: true as const },
  ]) {
    const dispatch = new WriteDispatch();
    await expect(
      send(reviews({ write: () => reply }).reviews, action, dispatch),
    ).rejects.toMatchObject({
      kind: "outcome_uncertain",
    });
    expect(dispatch.definitelyFailed).toBe(false);
  }
});

test("an uncertain comment reconciles as landed only when the viewer's marked comment is on the pull request", async () => {
  const action: ForgeReviewAction = { kind: "line.comment", headSha: head, anchor, body: "Rename" };
  const comment = (user: unknown, raw: string, inline = { path: "src/a.ts", to: 12 }) => ({
    [`${pr}/comments?pagelen=100`]: {
      values: [{ id: 9, content: { raw }, user, created_on: "2026-11-02", inline }],
    },
  });
  const landed = reviews({ replies: comment(me, `Rename\n\n${marker}`) }).reviews;
  await expect(landed.reconcile(7, action, "op-1", signal)).resolves.toBe(true);
  for (const replies of [
    comment(me, "Rename"),
    comment(author, `Rename\n\n${marker}`),
    comment(me, `Rename\n\n${marker}`, { path: "src/a.ts", to: 13 }),
  ])
    await expect(reviews({ replies }).reviews.reconcile(7, action, "op-1", signal)).resolves.toBe(
      false,
    );
});

test("an uncertain approval reconciles from the viewer's participant state", async () => {
  const action: ForgeReviewAction = {
    kind: "submit",
    headSha: head,
    event: "APPROVE",
    body: "",
    draftIds: [],
  };
  const state = (approved: boolean) => ({
    [pr]: pullRequest({
      participants: [
        { user: me, role: "PARTICIPANT", approved, state: approved ? "approved" : null },
      ],
    }),
  });
  await expect(
    reviews({ replies: state(true) }).reviews.reconcile(7, action, "op-1", signal),
  ).resolves.toBe(true);
  await expect(
    reviews({ replies: state(false) }).reviews.reconcile(7, action, "op-1", signal),
  ).resolves.toBe(false);
});

test("the conversation groups inline replies into threads and lists each verdict", async () => {
  const replies = {
    [pr]: pullRequest({
      participants: [
        {
          user: me,
          role: "REVIEWER",
          approved: true,
          state: "approved",
          participated_on: "2026-11-03",
        },
        { user: author, role: "PARTICIPANT", approved: false, state: null },
      ],
    }),
    [`${pr}/comments?pagelen=100`]: {
      values: [
        { id: 1, content: { raw: "General" }, user: author, created_on: "2026-11-02" },
        {
          id: 2,
          content: { raw: "Inline" },
          user: me,
          created_on: "2026-11-02",
          inline: { path: "a.ts", to: 4 },
          resolution: { type: "comment_resolution" },
        },
        {
          id: 3,
          content: { raw: "Reply" },
          user: author,
          created_on: "2026-11-02",
          parent: { id: 2 },
        },
        { id: 4, content: { raw: "Gone" }, user: author, created_on: "2026-11-02", deleted: true },
        { id: 5, content: { raw: "Draft" }, user: author, created_on: "2026-11-02", pending: true },
      ],
    },
  };
  const { reviews: r } = reviews({ replies });
  const conversation = await r.conversation(7, signal);
  expect(conversation.reviewThreads).toEqual([
    expect.objectContaining({
      id: "2",
      resolved: true,
      file: "a.ts",
      line: 4,
      side: "RIGHT",
      comments: [
        expect.objectContaining({ id: 2 }),
        expect.objectContaining({ id: 3, replyTo: 2, kind: "inline" }),
      ],
    }),
  ]);
  expect(conversation.comments.map((c) => [c.id, c.kind])).toEqual([
    [1, "issue"],
    [2, "inline"],
    [3, "inline"],
    [reviewId(me.uuid), "review"],
  ]);
  const reviewers = await r.reviewers(7, signal);
  expect(reviewers.reviews).toEqual([
    { id: reviewId(me.uuid), login: "Ada", state: "APPROVED", submittedAt: "2026-11-03" },
  ]);
});
