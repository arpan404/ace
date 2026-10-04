import { expect, test } from "vitest";
import { Interaction, type PermissionReview } from "@ace/protocol";
import { approval, catchUp, end, start, storeFixture, turns } from "./long-thread-test-support.ts";

// Mutations: infer auto-review from a device string, require an explicit closure flag,
// count repeated review delivery twice, or move a late review into the current turn.
// Not executed (tests run at merge).
test("canonical auto-review facts update the original approval once even during a later root run", () => {
  const f = storeFixture();
  start(f.store, f.thread, "original", 20);
  const request = approval(f.thread, "reviewed-approval");
  f.store.appendEvents(f.thread.id, [{ type: "interaction.opened", interaction: request }], 25);
  end(f.store, f.thread, "original", 30);
  start(f.store, f.thread, "next", 40);
  const boundary = f.store.headSeq();
  const review: PermissionReview = {
    interactionId: request.id,
    mode: "auto-review",
    reviewer: "ace-risk-policy",
    decision: "approve",
    reason: "Read-only inspection",
  };
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "permission.reviewed", review },
      { type: "permission.reviewed", review },
      { type: "interaction.closed", interactionId: request.id, state: "resolved", closedAt: 50 },
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

// Mutations: discard an already-reviewed interaction during replay or count an ask-mode
// decision as auto-review. Not executed (tests run at merge).
test("persisted interaction reviews are counted without mistaking ask mode for auto-review", () => {
  const f = storeFixture();
  start(f.store, f.thread, "reviewed", 20);
  for (const [id, mode] of [
    ["automatic", "auto-review"],
    ["manual", "ask"],
  ] as const) {
    const request = approval(f.thread, id);
    const interaction = Interaction.parse({
      ...request,
      review: {
        interactionId: request.id,
        mode,
        reviewer: "ace-risk-policy",
        decision: "escalate",
        reason: "Needs human review",
      },
    });
    f.store.appendEvents(f.thread.id, [{ type: "interaction.opened", interaction }], 25);
  }
  expect(turns(f.store, f.thread).turns[0]?.digest).toMatchObject({
    approvalsAsked: 2,
    approvalsAutoReviewed: 1,
    approvalsPending: 2,
  });
});
