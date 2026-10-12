import { expect, test } from "vitest";
import { reviewFixtures } from "@ace/forge/testing";
import { setupReview } from "./hosted-review-test-support.ts";

for (const source of ["issue", "inline"] as const)
  test(`an external ${source} comment edit refuses the old snapshot without fencing a fresh edit`, async () => {
    const fixtures = reviewFixtures();
    const read = `repos/octo/ace/${source === "inline" ? "pulls" : "issues"}/7/comments?per_page=100`;
    const write = `repos/octo/ace/${source === "inline" ? "pulls" : "issues"}/comments/7`;
    const external = { id: 7, body: "External B", user: { login: "reviewer" } };
    fixtures[read] = [{ body: [external] }];
    fixtures[write] = [{ body: { ...external, body: "Edited B" } }];
    const f = await setupReview(fixtures);
    try {
      expect(
        await f.send("stale", {
          kind: "comment.edit",
          source,
          commentId: 7,
          expectedBody: "Original A",
          body: "Edited A",
        }),
      ).toMatchObject({ ok: false, error: "forge_conflict" });
      expect((await f.gh.requests()).some((request) => request.args.includes("PATCH"))).toBe(false);
      expect((await f.state()).operations).toEqual([]);
      expect(
        await f.send("fresh", {
          kind: "comment.edit",
          source,
          commentId: 7,
          expectedBody: external.body,
          body: "Edited B",
        }),
      ).toMatchObject({ ok: true });
      expect((await f.gh.requests()).find((request) => request.path === write)?.body).toEqual({
        body: "Edited B",
      });
    } finally {
      await f.cleanup();
    }
  });
