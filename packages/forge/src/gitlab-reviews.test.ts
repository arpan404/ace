import { expect, test } from "vitest";
import type { ForgeReviewAction } from "@ace/protocol/forge-review";
import { GitLabReviews, gitLabReviewWrites } from "./gitlab-reviews.ts";
import { isAdmittedWriteRequest, isReadOnlyApiRequest } from "./read-only-api.ts";
import { pinnedRunner } from "./pinned-runner.ts";
import {
  fixture,
  repository,
  head,
  base,
  start,
  root,
  note,
  position,
  reply,
} from "./gitlab-review-test-support.ts";
import { reviewWriteMarker } from "./github-reviews.ts";
const signal = new AbortController().signal;
const line = {
  kind: "line.comment",
  headSha: head,
  body: "fix",
  anchor: { commit: head, path: "new.ts", line: 2, side: "RIGHT" },
} as const;
const cases: {
  name: string;
  action: ForgeReviewAction;
  endpoint: string;
  method: string;
  body: unknown;
}[] = [
  {
    name: "general note",
    action: { kind: "conversation", body: "hello" },
    endpoint: `${root}/notes`,
    method: "POST",
    body: { body: `hello\n\n${reviewWriteMarker("op")}` },
  },
  {
    name: "discussion reply",
    action: { kind: "reply", commentId: 11, body: "reply" },
    endpoint: `${root}/discussions/abcdef/notes`,
    method: "POST",
    body: { body: `reply\n\n${reviewWriteMarker("op")}` },
  },
  {
    name: "line comment",
    action: line,
    endpoint: `${root}/discussions`,
    method: "POST",
    body: {
      body: `fix\n\n${reviewWriteMarker("op")}`,
      position: {
        position_type: "text",
        base_sha: base,
        start_sha: start,
        head_sha: head,
        old_path: "old.ts",
        new_path: "new.ts",
        new_line: 2,
      },
    },
  },
  {
    name: "resolve",
    action: { kind: "thread.resolve", threadId: "abcdef" },
    endpoint: `${root}/discussions/abcdef?resolved=true`,
    method: "PUT",
    body: {},
  },
  {
    name: "unresolve",
    action: { kind: "thread.unresolve", threadId: "abcdef" },
    endpoint: `${root}/discussions/abcdef?resolved=false`,
    method: "PUT",
    body: {},
  },
  {
    name: "approve",
    action: { kind: "submit", event: "APPROVE", headSha: head, body: "", draftIds: [] },
    endpoint: `${root}/approve`,
    method: "POST",
    body: { sha: head },
  },
  {
    name: "unapprove own approval",
    action: { kind: "review.dismiss", reviewId: 42, message: "withdraw" },
    endpoint: `${root}/unapprove`,
    method: "POST",
    body: {},
  },
  {
    name: "request reviewer",
    action: { kind: "reviewers.request", reviewers: ["alice"] },
    endpoint: root,
    method: "PUT",
    body: { reviewer_ids: [42] },
  },
  {
    name: "remove reviewer",
    action: { kind: "reviewers.remove", reviewers: ["alice"] },
    endpoint: root,
    method: "PUT",
    body: { reviewer_ids: [] },
  },
];
test.each(cases)("$name sends exactly its admitted write", async (row) => {
  const f = fixture();
  await new GitLabReviews({ repository, runner: f.runner }).write(
    7,
    row.action,
    [],
    "op",
    signal,
    () => true,
  );
  const writes = f.seen.filter((r) => r.input !== undefined);
  expect(writes).toHaveLength(1);
  const written = writes[0];
  if (!written) throw new Error("No write sent");
  expect(written.args).toEqual([
    "api",
    row.endpoint,
    "-X",
    row.method,
    "--hostname",
    repository.host,
    "--include",
    "--input",
    "-",
  ]);
  expect(JSON.parse(written.input ?? "null")).toEqual(row.body);
  expect(
    isAdmittedWriteRequest("glab", written, repository.host, gitLabReviewWrites(repository, 7)),
  ).toBe(true);
  for (const changed of [
    { ...written, args: [...written.args, "--paginate"] },
    { ...written, args: ["api", row.endpoint.replace("/7", "/8"), ...written.args.slice(2)] },
    { ...written, command: "gh" },
    { ...written, input: "[]" },
  ])
    expect(
      isAdmittedWriteRequest("glab", changed, repository.host, gitLabReviewWrites(repository, 7)),
    ).toBe(false);
});

test("moving the head before a line write dispatches nothing", async () => {
  let reads = 0;
  const f = fixture((req) =>
    req.args[1] === root && ++reads === 2
      ? reply({
          iid: 7,
          title: "moved",
          state: "opened",
          updated_at: note.updated_at,
          sha: "f".repeat(40),
          diff_refs: { head_sha: "f".repeat(40), base_sha: base, start_sha: start },
        })
      : undefined,
  );
  await expect(
    new GitLabReviews({ repository, runner: f.runner }).write(
      7,
      line,
      [],
      "op",
      signal,
      () => true,
    ),
  ).rejects.toMatchObject({ kind: "head_moved" });
  expect(f.seen.filter((r) => r.input)).toEqual([]);
});

test("account switches before dispatch fail closed and switches after dispatch stay uncertain", async () => {
  for (const after of [false, true]) {
    let probes = 0;
    const f = fixture();
    const runner = pinnedRunner({
      runner: f.runner,
      account: "alice",
      identify: async () => (++probes === 1 && after ? "alice" : "bob"),
      pins: () => true,
      isWrite: (r) => !isReadOnlyApiRequest("glab", r, repository.host),
      assertCurrent: () => {},
    });
    await expect(
      new GitLabReviews({ repository, runner }).write(
        7,
        { kind: "conversation", body: "hello" },
        [],
        "op",
        signal,
        () => true,
      ),
    ).rejects.toMatchObject({ kind: after ? "outcome_uncertain" : "forbidden" });
    expect(f.seen.filter((r) => r.input).length).toBe(after ? 1 : 0);
  }
});

test("a lost write response is reconciled by its own discussion marker without a second write", async () => {
  let landed = false;
  const f = fixture((req) => {
    if (req.input) {
      req.dispatch?.prepare?.();
      req.dispatch?.record();
      landed = true;
      return { code: 1, stdout: "", truncated: false, unreachable: true };
    }
    if (landed && req.args[1]?.includes("/discussions?"))
      return reply([
        {
          id: "abcdef",
          individual_note: false,
          notes: [{ ...note, body: `fix\n\n${reviewWriteMarker("op")}`, position }],
        },
      ]);
    return;
  });
  const reviews = new GitLabReviews({ repository, runner: f.runner });
  await expect(reviews.write(7, line, [], "op", signal, () => true)).rejects.toMatchObject({
    kind: "outcome_uncertain",
  });
  expect(await reviews.reconcile(7, line, "op", signal)).toBe(true);
  expect(await reviews.reconcile(7, line, "other", signal)).toBe(false);
  expect(f.seen.filter((r) => r.input)).toHaveLength(1);
});

test("foreign approvals and unsupported review bodies cannot be silently changed", async () => {
  const f = fixture();
  const reviews = new GitLabReviews({ repository, runner: f.runner });
  await expect(
    reviews.write(
      7,
      { kind: "review.dismiss", reviewId: 99, message: "no" },
      [],
      "op",
      signal,
      () => true,
    ),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await expect(
    reviews.write(
      7,
      { kind: "submit", headSha: head, event: "APPROVE", body: "keep me", draftIds: [] },
      [],
      "op",
      signal,
      () => true,
    ),
  ).rejects.toMatchObject({ kind: "unsupported" });
  expect(f.seen.filter((r) => r.input)).toEqual([]);
});

test("reviewer usernames with dots resolve to ids before the MR update", async () => {
  const f = fixture((req) =>
    req.args[1] === "users?username=alice.smith"
      ? reply([{ id: 99, username: "alice.smith" }])
      : undefined,
  );
  await new GitLabReviews({ repository, runner: f.runner }).write(
    7,
    { kind: "reviewers.request", reviewers: ["alice.smith"] },
    [],
    "dots",
    signal,
    () => true,
  );
  const write = f.seen.find((r) => r.input !== undefined);
  expect(JSON.parse(write?.input ?? "null")).toEqual({ reviewer_ids: [42, 99] });
});

test.each([403, 409, 422, 429])(
  "a definitive HTTP %s refusal releases a dispatched write",
  async (code) => {
    const f = fixture((req) => {
      if (!req.input) return;
      req.dispatch?.prepare?.();
      req.dispatch?.record();
      return { code: 1, truncated: false, stdout: `HTTP/2.0 ${code} Refused\r\n\r\n{}` };
    });
    await expect(
      new GitLabReviews({ repository, runner: f.runner }).write(
        7,
        { kind: "conversation", body: "hello" },
        [],
        "refused",
        signal,
        () => true,
      ),
    ).rejects.toMatchObject({
      dispatched: false,
      kind:
        code === 403
          ? "forbidden"
          : code === 409
            ? "conflict"
            : code === 422
              ? "unprocessable"
              : "rate_limit",
    });
  },
);

test.each([
  { side: "LEFT" as const, path: "old.ts", line: 1, old: 1, next: 1 },
  { side: "RIGHT" as const, path: "new.ts", line: 1, old: 1, next: 1 },
  { side: "LEFT" as const, path: "old.ts", line: 2, old: 2, next: undefined },
])("a $side line at $line carries the exact old and new coordinates", async (row) => {
  const f = fixture((req) =>
    req.args[1]?.includes("/diffs?")
      ? reply([{ old_path: "old.ts", new_path: "new.ts", diff: "@@ -1,2 +1 @@\n same\n-deleted" }])
      : undefined,
  );
  await new GitLabReviews({ repository, runner: f.runner }).write(
    7,
    { ...line, anchor: { commit: head, side: row.side, path: row.path, line: row.line } },
    [],
    "coordinates",
    signal,
    () => true,
  );
  const written = f.seen.find((r) => r.input !== undefined);
  expect(JSON.parse(written?.input ?? "null").position).toEqual({
    position_type: "text",
    base_sha: base,
    start_sha: start,
    head_sha: head,
    old_path: "old.ts",
    new_path: "new.ts",
    old_line: row.old,
    ...(row.next === undefined ? {} : { new_line: row.next }),
  });
});
