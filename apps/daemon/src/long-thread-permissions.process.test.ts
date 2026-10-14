import { expect, test } from "vitest";
import { approval, catchUp, end, start, storeFixture, turns } from "./long-thread-test-support.ts";

// Mutations: infer auto-review from a device string or move a late review into the current
// turn. Not executed (tests run at merge).
test("a provider's auto-review updates the original approval even during a later root run", () => {
  const f = storeFixture();
  start(f.store, f.thread, "original", 20);
  const request = approval(f.thread, "reviewed-approval");
  f.store.appendEvents(f.thread.id, [{ type: "interaction.opened", interaction: request }], 25);
  end(f.store, f.thread, "original", 30);
  start(f.store, f.thread, "next", 40);
  const boundary = f.store.headSeq();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "interaction.closed",
        interactionId: request.id,
        state: "resolved",
        closedAt: 50,
        autoReviewed: true,
      },
    ],
    50,
  );
  const [original, next] = turns(f.store, f.thread).turns;
  expect(original?.digest).toMatchObject({
    approvalsAsked: 1,
    approvalsAnswered: 1,
    approvalsAutoReviewed: 1,
    approvalsPending: 0,
  });
  expect(next?.digest.approvalsAutoReviewed).toBe(0);
  expect(catchUp(f.store, f.thread, { sinceSeq: boundary }).digest).toMatchObject({
    approvalsAsked: 0,
    approvalsAnswered: 1,
    approvalsAutoReviewed: 1,
  });
});
