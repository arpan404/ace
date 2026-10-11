import { expect, test } from "vitest";
import { reviewWriteMarker } from "@ace/forge";
import { reviewFixtures } from "@ace/forge/testing";
import { setupReview } from "./hosted-review-test-support.ts";

for (const source of ["issue", "inline"] as const)
  for (const kind of ["comment.edit", "comment.delete"] as const)
    test(`${source} ${kind} accepts the full hosted body of a maximum-length authored comment`, async () => {
      const authored = "x".repeat(60_000);
      const hosted = `${authored}\n\n${reviewWriteMarker("post")}`;
      const parent = { id: 1, body: "Parent", user: { login: "author" } };
      const posted = {
        id: 77,
        body: hosted,
        user: { login: "reviewer" },
        ...(source === "inline" ? { in_reply_to_id: 1 } : {}),
      };
      const edited = authored.slice(0, -1);
      const changed = { ...posted, body: `${edited}\n\n${reviewWriteMarker("post")}` };
      const fixtures = reviewFixtures();
      const root = "repos/octo/ace";
      const read = `${root}/${source === "inline" ? "pulls" : "issues"}/7/comments?per_page=100`;
      const publish =
        source === "inline" ? `${root}/pulls/7/comments/1/replies` : `${root}/issues/7/comments`;
      const mutate = `${root}/${source === "inline" ? "pulls" : "issues"}/comments/77`;
      const parents = source === "inline" ? [parent] : [];
      fixtures[read] = [
        ...(source === "inline" ? [{ body: parents }] : []),
        { body: [...parents, posted] },
        { body: kind === "comment.edit" ? [...parents, changed] : parents },
      ];
      fixtures[publish] = [{ body: posted }];
      fixtures[mutate] = kind === "comment.edit" ? [{ body: changed }] : [{ status: 204 }];
      const action =
        kind === "comment.edit"
          ? { kind, source, commentId: posted.id, expectedBody: hosted, body: edited }
          : { kind, source, commentId: posted.id, expectedBody: hosted };
      const f = await setupReview(fixtures);
      try {
        expect(
          await f.send(
            "post",
            source === "inline"
              ? { kind: "reply", commentId: parent.id, body: authored }
              : { kind: "conversation", body: authored },
          ),
        ).toMatchObject({ ok: true });
        expect(await f.send("modify", action)).toMatchObject({ ok: true });
        expect(
          await f.gh.forge.reviews.reconcile(7, action, "modify", new AbortController().signal),
        ).toBe(true);
        const requests = await f.gh.requests();
        expect(requests.find((r) => r.path === publish && r.args.includes("POST"))?.body).toEqual({
          body: hosted,
        });
        const modification = requests.find((r) => r.path === mutate);
        expect(modification?.args).toContain(kind === "comment.edit" ? "PATCH" : "DELETE");
        if (kind === "comment.edit") expect(modification?.body).toEqual({ body: changed.body });
      } finally {
        await f.cleanup();
      }
    });
