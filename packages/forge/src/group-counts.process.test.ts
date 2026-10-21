import { expect, test } from "vitest";
import { z } from "zod";
import { ForgeIssueSearch } from "@ace/protocol/forge-issues";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import { fakeGh } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
/** GitHub's answer: one `issueCount` per aliased search, in order. */
const counts = (...values: number[]) => {
  const data: Record<string, { issueCount: number; nodes?: unknown[] }> = Object.fromEntries(
    values.map((value, index) => [`c${index}`, { issueCount: value }]),
  );
  return { body: { data } };
};
const searches = (body: unknown) =>
  [
    ...z
      .object({ query: z.string() })
      .parse(body)
      .query.matchAll(/query: ("(?:[^"\\]|\\.)*")/g),
  ].map((match) => z.string().parse(JSON.parse(match[1] ?? '""')));

test("readiness tiers are counted in one request, each PR once, in its first tier", async () => {
  // Open total 40: changes 3 + 2, review 7, "pending" 4 of which one has no checks at all (so
  // it is ready), ready 10, so 14 left as other; 6 drafts.
  const answer = counts(40, 3, 2, 7, 4, 10, 6);
  answer.body.data.c4 = Object.assign(answer.body.data.c4 ?? { issueCount: 4 }, {
    nodes: [
      { statusCheckRollup: null },
      { statusCheckRollup: { state: "PENDING" } },
      { statusCheckRollup: { state: "EXPECTED" } },
      {},
    ],
  });
  const gh = await fakeGh({ graphql: [answer] });
  try {
    const result = await gh.forge.groupCounts(
      { by: "readiness", query: ForgePrSearch.parse({ labels: ["bug"], state: "active" }) },
      signal(),
    );
    expect(result).toEqual({ changes: 5, review: 7, checks: 3, ready: 11, other: 14, drafts: 6 });
    const sent = (await gh.requests()).filter((request) => request.path === "graphql");
    expect(sent).toHaveLength(1);
    const queries = searches(sent[0]?.body);
    const open = 'repo:octo/ace is:pr is:open draft:false label:"bug"';
    expect(queries).toEqual([
      open,
      `${open} review:changes_requested`,
      `${open} status:failure -review:changes_requested`,
      `${open} review:required -status:failure`,
      `${open} status:pending -review:required -review:changes_requested`,
      `${open} status:success -review:required -review:changes_requested`,
      'repo:octo/ace is:pr is:open draft:true label:"bug"',
    ]);
  } finally {
    await gh.cleanup();
  }
});

test("people groups count yours, then those asking your review, then the rest of the search", async () => {
  const gh = await fakeGh({ graphql: [counts(30, 4, 6)] });
  try {
    expect(
      await gh.forge.groupCounts({ by: "pr-people", query: ForgePrSearch.parse({}) }, signal()),
    ).toEqual({ authored: 4, reviewing: 6, others: 20 });
  } finally {
    await gh.cleanup();
  }
});

test("issue groups count assigned to you, then opened by you, then the rest", async () => {
  const gh = await fakeGh({ graphql: [counts(12, 3, 2)] });
  try {
    expect(
      await gh.forge.groupCounts(
        { by: "issue-people", query: ForgeIssueSearch.parse({ state: "closed" }) },
        signal(),
      ),
    ).toEqual({ assigned: 3, created: 2, others: 7 });
    const sent = (await gh.requests()).find((request) => request.path === "graphql");
    expect(searches(sent?.body)).toEqual([
      "repo:octo/ace is:issue is:closed",
      "repo:octo/ace is:issue is:closed assignee:@me",
      "repo:octo/ace is:issue is:closed author:@me -assignee:@me",
    ]);
  } finally {
    await gh.cleanup();
  }
});

test("an answer missing a count fails rather than showing a wrong total", async () => {
  const gh = await fakeGh({ graphql: [counts(30, 4)] });
  try {
    await expect(
      gh.forge.groupCounts({ by: "pr-people", query: ForgePrSearch.parse({}) }, signal()),
    ).rejects.toMatchObject({ kind: "invalid_data" });
  } finally {
    await gh.cleanup();
  }
});
