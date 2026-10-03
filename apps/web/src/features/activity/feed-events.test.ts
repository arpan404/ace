import { ForgePrStatus, ThreadId, WorkspaceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { pullRequestEvents, type LinkedThread } from "./feed-events.ts";

const thread = (patch: Partial<LinkedThread> = {}): LinkedThread => ({
  id: ThreadId.parse("thread-pdf"),
  title: "Invoice PDF locale fallback",
  workspaceId: WorkspaceId.parse("billing-api"),
  updatedAt: 5_000,
  pr: { number: 74, state: "open" },
  ...patch,
});

const status = (patch: Partial<ForgePrStatus> = {}) =>
  ForgePrStatus.parse({
    ref: {
      repository: { forge: "github", host: "github.com", owner: "acme", name: "billing" },
      number: 74,
    },
    title: "Locale fallback for PDFs",
    url: "https://github.com/acme/billing/pull/74",
    headSha: "a".repeat(40),
    state: "open",
    mergeability: "mergeable",
    ci: "none",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: {},
    ...patch,
  });

const check = (name: string, state: "success" | "failure", at: string) => ({
  id: name,
  name,
  status: state,
  conclusion: state,
  completedAt: at,
  jobId: null,
  url: null,
});

const comment = (id: number, body: string, at: string) => ({
  kind: "review" as const,
  id,
  body,
  author: "mira",
  file: null,
  line: null,
  updatedAt: at,
  replyTo: null,
});

test("failing checks are one event per head, timed by the last failure", () => {
  const failing = status({
    ci: "failure",
    checks: [
      check("lint", "success", "2026-10-03T10:00:00Z"),
      check("unit", "failure", "2026-10-03T10:05:00Z"),
      check("e2e", "failure", "2026-10-03T10:07:00Z"),
    ],
  });
  const [event] = pullRequestEvents(thread(), failing);
  expect(event).toMatchObject({
    kind: "ci",
    title: "Checks failed on #74",
    context: "Locale fallback for PDFs · 2 failing",
    at: Date.parse("2026-10-03T10:07:00Z"),
    outcome: "failed",
    threadId: "thread-pdf",
  });
  const pushed = pullRequestEvents(thread(), { ...failing, headSha: "b".repeat(40) })[0];
  expect(pushed?.id).not.toBe(event?.id);
  expect(pullRequestEvents(thread(), status({ ci: "success" }))).toEqual([]);
});

test("only comments that mention someone reach the feed, the newest three per PR", () => {
  const events = pullRequestEvents(
    thread(),
    status({
      comments: [
        comment(1, "Looks good", "2026-10-03T09:00:00Z"),
        comment(2, "@you which port?", "2026-10-03T09:01:00Z"),
        comment(3, "cc @ops", "2026-10-03T09:02:00Z"),
        comment(4, "@you also the docs", "2026-10-03T09:03:00Z"),
        comment(5, "@you and the changelog\nsecond line", "2026-10-03T09:04:00Z"),
        comment(6, "email me at a@b.c", "2026-10-03T09:05:00Z"),
      ],
    }),
  );
  expect(events.map((event) => event.title)).toEqual([
    "mira: @you and the changelog",
    "mira: @you also the docs",
    "mira: cc @ops",
  ]);
  expect(events.every((event) => event.kind === "mention")).toBe(true);
});

test("a merged PR is dated by the settlement the daemon recorded for it", () => {
  const [merged] = pullRequestEvents(
    thread({ settledAt: 4_000, settledReason: "pr_merged", pr: { number: 74, state: "merged" } }),
    status({ state: "merged" }),
  );
  expect(merged).toMatchObject({ kind: "pr", title: "PR #74 merged", at: 4_000, outcome: "done" });
  // Settled for another reason: the thread's last update is the best time there is.
  const [closed] = pullRequestEvents(
    thread({ settledAt: 4_000, settledReason: "manual", pr: { number: 74, state: "closed" } }),
    null,
  );
  expect(closed).toMatchObject({
    title: "PR #74 closed",
    at: 5_000,
    context: "Invoice PDF locale fallback",
  });
});

test("an open PR the forge can't read adds nothing", () => {
  expect(pullRequestEvents(thread(), null)).toEqual([]);
});
