import { expect, test } from "vitest";
import { GitLabReader } from "./gitlab-reader.ts";
import {
  fixture,
  repository,
  root,
  note,
  position,
  head,
  reply,
  user,
} from "./gitlab-review-test-support.ts";
const signal = new AbortController().signal;

test.each([
  { new_line: 2, old_line: null, side: "RIGHT", file: "new.ts" },
  { new_line: null, old_line: 5, side: "LEFT", file: "old.ts" },
])("diff discussions retain $side anchors, outdated state and resolution", async (row) => {
  const f = fixture((req) =>
    req.args[1]?.includes("/discussions?")
      ? reply([
          {
            id: "abcdef",
            individual_note: false,
            notes: [
              {
                ...note,
                resolved: true,
                position: { ...position, ...row, head_sha: "d".repeat(40) },
              },
              { ...note, id: 12, resolved: true },
            ],
          },
          {
            id: "fedcba",
            individual_note: true,
            notes: [{ ...note, id: 13, system: true, body: "merged" }],
          },
          {
            id: "aaaaaa",
            individual_note: true,
            notes: [{ ...note, id: 14, resolvable: false, body: "General" }],
          },
        ])
      : undefined,
  );
  const reader = new GitLabReader({ repository, runner: f.runner });
  const status = await reader.status(7, signal);
  expect(status.reviewThreads).toMatchObject([
    {
      id: "abcdef",
      resolved: true,
      outdated: true,
      side: row.side,
      file: row.file,
      line: row.new_line ?? row.old_line,
      comments: [{ id: 11 }, { id: 12, replyTo: 11 }],
    },
  ]);
  expect(status.comments.map((c) => c.id)).toEqual([11, 12, 14]);
  expect((await reader.prActivity(7, 1, signal)).events).toMatchObject([
    { id: "13", event: "system", subject: "merged" },
  ]);
});

test.each([
  { approved: true, rules: [{ approved: false }], decision: "REVIEW_REQUIRED" },
  { approved: false, rules: [{ approved: true }], decision: "APPROVED" },
  { approved: false, rules: [], decision: "REVIEW_REQUIRED" },
])("approval rules and totals produce $decision", async (row) => {
  const f = fixture((req) =>
    req.args[1] === `${root}/approvals`
      ? reply({ approved: row.approved, approved_by: [{ user, approved_at: note.created_at }] })
      : req.args[1] === `${root}/approval_state`
        ? reply({ rules: row.rules })
        : undefined,
  );
  const reader = new GitLabReader({ repository, runner: f.runner });
  const detail = await reader.prDetail(7, signal);
  expect(detail.reviewDecision).toBe(row.decision);
  expect(detail.commits).toBe(1);
  expect(detail.unavailableResources).toEqual([]);
  expect((await reader.prReviewers(7, signal)).reviews).toMatchObject([
    { login: "alice", state: "APPROVED" },
  ]);
  expect((await reader.prCommits(7, undefined, head, signal)).commits).toMatchObject([
    { sha: head, message: "Change", author: "Alice" },
  ]);
});

test("discussion pagination is followed without dropping earlier notes", async () => {
  const f = fixture((req) =>
    req.args[1]?.includes("/discussions?")
      ? reply(
          [
            {
              id: req.args[1].endsWith("page=1") ? "aa" : "bb",
              individual_note: true,
              notes: [{ ...note, id: req.args[1].endsWith("page=1") ? 1 : 2 }],
            },
          ],
          { "x-next-page": req.args[1].endsWith("page=1") ? "2" : "" },
        )
      : undefined,
  );
  expect(
    (await new GitLabReader({ repository, runner: f.runner }).status(7, signal)).comments.map(
      (c) => c.id,
    ),
  ).toEqual([1, 2]);
});

test("a head changed during discussion reads refuses the mixed snapshot", async () => {
  let reads = 0;
  const f = fixture((req) =>
    req.args[1] === root && ++reads > 1
      ? reply({
          iid: 7,
          title: "Moved",
          state: "opened",
          updated_at: note.updated_at,
          sha: "e".repeat(40),
        })
      : undefined,
  );
  await expect(
    new GitLabReader({ repository, runner: f.runner }).status(7, signal),
  ).rejects.toMatchObject({ kind: "head_moved" });
});
