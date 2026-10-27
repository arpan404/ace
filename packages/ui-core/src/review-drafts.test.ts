import { describe, expect, it } from "vitest";
import { record, type DraftStore, type ReviewDraft } from "./review-drafts.ts";

function memoryStore(initial: ReviewDraft[]): DraftStore {
  let drafts: readonly ReviewDraft[] = initial;
  return { get: () => drafts, set: (next) => void (drafts = next(drafts)) };
}

const fingerprint = { before: [], lines: ["const out = [];"], after: [] };
const draft: ReviewDraft = {
  key: "local",
  threadId: "thread-1",
  file: "src/window.ts",
  side: "new",
  line: 5,
  text: "Bound it by bytes.",
  state: "sending",
  fingerprint,
  createdAt: 1,
};

describe("recording a review comment", () => {
  it("leaves one copy when a refresh fetched the daemon's copy while it was being recorded", async () => {
    const store = memoryStore([draft]);
    const client = {
      async command(payload: { type: string }) {
        if (payload.type === "review.open")
          return { ok: true as const, review: { session: { id: "s1" } } };
        // A refresh lands while the comment is recorded: the daemon's copy arrives first.
        store.set((drafts) => [
          ...drafts,
          { ...draft, key: "remote:s1:c1", commentId: "c1", sessionId: "s1", state: "draft" },
        ]);
        return { ok: true as const, review: { comment: { id: "c1" } } };
      },
    };
    const thread = { id: "thread-1", workspaceId: "ws-1" } as unknown as Parameters<
      typeof record
    >[2];
    const result = await record(client as unknown as Parameters<typeof record>[0], store, thread, [draft], () => "comment-command");
    expect(result.commentIds).toEqual(["c1"]);
    expect(store.get().map((each) => [each.key, each.commentId])).toEqual([["local", "c1"]]);
  });
});
