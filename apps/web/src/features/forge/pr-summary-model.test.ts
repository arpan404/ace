import { expect, test } from "vitest";
import { ForgeComment, type ForgePrStatus } from "@ace/protocol";
import { attentionItems, biggestFiles, conversation, fixRequest } from "./pr-summary-model.ts";

const comment = (
  id: number,
  author: string,
  at: string,
  patch: Partial<ForgeComment> = {},
): ForgeComment =>
  ForgeComment.parse({
    kind: "issue",
    id,
    author,
    body: `comment ${id}`,
    file: null,
    line: null,
    replyTo: null,
    createdAt: at,
    updatedAt: at,
    ...patch,
  });
const thread = (
  id: string,
  resolved: boolean,
  comments: ForgeComment[],
): ForgePrStatus["reviewThreads"][number] => ({
  id,
  resolved,
  outdated: false,
  file: "src/a.ts",
  line: 3,
  comments,
});
const ids = (view: ReturnType<typeof conversation>) => view.items.map((item) => item.key);
const all = { bots: true, resolved: true, order: "newest", limit: 10 } as const;

test("inline comments held by a review thread are listed once, as the thread", () => {
  const inline = comment(5, "mira", "2026-01-02", { kind: "inline", file: "src/a.ts", line: 3 });
  const view = conversation(
    {
      comments: [comment(1, "sam", "2026-01-01"), inline],
      reviewThreads: [thread("T", false, [inline])],
    },
    all,
  );
  expect(ids(view)).toEqual(["thread:T", "issue:1"]);
  expect(view.total).toBe(2);
});

test("filters hide bots, resolved threads and dismissed reviews, and count what they hide", () => {
  const view = conversation(
    {
      comments: [
        comment(1, "dependabot[bot]", "2026-01-01"),
        comment(2, "sam", "2026-01-02", { kind: "review", reviewState: "DISMISSED" }),
        comment(3, "sam", "2026-01-03"),
      ],
      reviewThreads: [thread("T", true, [comment(9, "mira", "2026-01-04")])],
    },
    { ...all, bots: false, resolved: false },
  );
  expect(ids(view)).toEqual(["issue:3"]);
  expect(view.filtered).toBe(3);
});

test("only the newest page shows, in either order, with the older ones counted", () => {
  const comments = Array.from({ length: 13 }, (_, index) =>
    comment(index + 1, "sam", `2026-01-${String(index + 1).padStart(2, "0")}`),
  );
  const newest = conversation({ comments, reviewThreads: [] }, all);
  expect(ids(newest)[0]).toBe("issue:13");
  expect(newest.items).toHaveLength(10);
  expect(newest.older).toBe(3);
  const oldest = conversation({ comments, reviewThreads: [] }, { ...all, order: "oldest" });
  expect(ids(oldest)[0]).toBe("issue:4");
  expect(ids(oldest).at(-1)).toBe("issue:13");
});

test("changes at a glance keeps the biggest files, split into folder and name, scaled to the biggest", () => {
  const files = biggestFiles(
    [
      { path: "README.md", additions: 1, deletions: 1 },
      { path: "src/pdf/render.ts", additions: 80, deletions: 20 },
      { path: "src/locale.ts", additions: 40, deletions: 10 },
    ],
    2,
  );
  expect(files.map((file) => [file.directory, file.name, file.scale])).toEqual([
    ["src/pdf/", "render.ts", 1],
    ["src/", "locale.ts", 0.5],
  ]);
});

test("needs attention lists failing checks, then open review threads, and nothing settled", () => {
  const failing = {
    id: "links",
    name: "links",
    status: "failure" as const,
    conclusion: "failure",
    completedAt: "2026-01-02",
    jobId: null,
    url: "https://ci/links",
  };
  const passing = { ...failing, id: "lint", name: "lint", status: "success" as const };
  const items = attentionItems({
    checks: [passing, failing],
    reviewThreads: [
      thread("open", false, [comment(7, "mira", "2026-01-03", { body: "Which port?\nMore" })]),
      thread("done", true, [comment(8, "sam", "2026-01-04")]),
    ],
  });
  expect(items.map((item) => [item.key, item.title, item.detail])).toEqual([
    ["check:links", "links", "failure"],
    ["thread:open", "Which port?", "src/a.ts:3"],
  ]);
  const [check, review] = items;
  if (!check || !review) throw new Error("expected two items");
  expect(fixRequest(check, { number: 31, url: "https://pr/31" })).toContain(
    'The check "links" fails on PR #31 (https://ci/links)',
  );
  expect(fixRequest(review, { number: 31, url: "https://pr/31" })).toContain(
    "Address mira's review comment on src/a.ts:3 in PR #31:\n\n> Which port?\n> More",
  );
});
