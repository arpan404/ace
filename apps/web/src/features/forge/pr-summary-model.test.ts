import { expect, test } from "vitest";
import { ForgeComment, type ForgePrStatus } from "@ace/protocol";
import { conversation, reviewerOutcomes } from "./pr-summary-model.ts";

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

test("a reviewer's latest verdict wins over earlier ones", () => {
  const outcomes = reviewerOutcomes([
    comment(1, "mira", "2026-01-01", { kind: "review", reviewState: "CHANGES_REQUESTED" }),
    comment(2, "mira", "2026-01-03", { kind: "review", reviewState: "APPROVED" }),
    comment(3, "sam", "2026-01-02", { kind: "review", reviewState: "CHANGES_REQUESTED" }),
    comment(4, "lee", "2026-01-02"),
  ]);
  expect(outcomes.get("mira")).toBe("approved");
  expect(outcomes.get("sam")).toBe("changes");
  expect(outcomes.has("lee")).toBe(false);
});

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
