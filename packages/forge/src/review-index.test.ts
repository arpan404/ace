import { expect, it } from "vitest";
import { ReviewIndex, mapPr } from "./index.ts";
import type { ForgeComment } from "@ace/protocol/forge";
import { pr, repository } from "./testing/fixtures.ts";
const link = { threadId: "index", pr: { repository, number: 7 } };
it("an observed large snapshot queues only edited feedback and removes withdrawn candidates", () => {
  const status = mapPr(link.pr, pr, []);
  status.comments = Array.from({ length: 2_000 }, (_, index): ForgeComment => ({
    kind: "issue",
    id: index + 1,
    body: `Feedback ${index}`,
    author: "alice",
    file: null,
    line: null,
    updatedAt: "now",
    replyTo: null,
  }));
  const index = new ReviewIndex({ link, generation: 1 }, new Set());
  index.update(status);
  const initial = [...index.pending()];
  expect(initial).toHaveLength(2_000);
  for (const candidate of initial) index.observe(candidate.key);
  index.update(status);
  expect([...index.pending()]).toEqual([]);
  const last = status.comments.at(-1);
  if (!last) throw new Error("Missing fixture comment");
  const changed = {
    ...status,
    comments: [...status.comments.slice(0, -1), { ...last, body: "Edited feedback" }],
  };
  index.update(changed);
  expect(
    [...index.pending()].map((candidate) =>
      candidate.type === "review" ? candidate.comment.body : "",
    ),
  ).toEqual(["Edited feedback"]);
  index.update({ ...changed, comments: changed.comments.slice(0, -1) });
  expect([...index.pending()]).toEqual([]);
  const old = initial.at(-1);
  if (!old) throw new Error("Missing fixture candidate");
  index.retry(old.key);
  expect([...index.pending()]).toEqual([]);
});
