import { expect, test } from "vitest";
import { reviewWriteMarker } from "@ace/forge";
import { inlineDraft, reviewed, reviewFixtures, sha } from "@ace/forge/testing";
import { setupReview } from "./hosted-review-test-support.ts";

test("uncertain reviews remain visible and recoverable after 100 accepted viewed writes and restart", async () => {
  const fixtures = reviewFixtures();
  const paths = Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`);
  fixtures["graphql:files(first:"] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              headRefOid: sha,
              files: {
                nodes: paths.map((path) => ({ path, viewerViewedState: "UNVIEWED" })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    },
  ];
  fixtures["graphql:mutation($input:MarkFileAsViewedInput!"] = [
    { body: { data: { markFileAsViewed: { clientMutationId: null } } } },
  ];
  fixtures["repos/octo/ace/pulls/7/reviews"] = [{ raw: "lost acknowledgement", code: 1 }];
  fixtures["repos/octo/ace/pulls/7/reviews?per_page=100"] = [{ body: [] }];
  const f = await setupReview(fixtures);
  try {
    await f.send("save", { kind: "draft.save", draft: inlineDraft });
    expect(await f.send("uncertain-review")).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
    });
    for (const [i, path] of paths.entries())
      expect(await f.send(`view-${i}`, { kind: "file.view", path, headSha: sha })).toMatchObject({
        ok: true,
      });
    await f.restart();
    const restored = await f.state();
    expect(restored.operations).toHaveLength(100);
    expect(restored.operations).toContainEqual({ id: "uncertain-review", state: "uncertain" });
    expect(restored.operations.filter((op) => op.state === "accepted")).toHaveLength(99);
    expect(restored.drafts).toEqual([inlineDraft]);
    expect(await f.send("retry-before-reconciliation")).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
    });
    // GitHub now exposes the original accepted review; recover without republishing.
    await f.gh.replace({
      ...fixtures,
      "repos/octo/ace/pulls/7/reviews?per_page=100": [
        { body: [{ ...reviewed, body: `Reviewed\n\n${reviewWriteMarker("uncertain-review")}` }] },
      ],
    });
    expect(
      await f.send("reconcile", { kind: "reconcile", operationId: "uncertain-review" }),
    ).toMatchObject({ ok: true });
    expect((await f.state()).drafts).toEqual([]);
    expect((await f.state()).operations.some((op) => op.state === "uncertain")).toBe(false);
    expect(
      (await f.gh.requests()).filter(
        (r) => r.path === "repos/octo/ace/pulls/7/reviews" && r.args.includes("POST"),
      ),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
}, 120_000);
