import { InteractionId, Item, type PermissionReview } from "@ace/protocol";
import { expect, test } from "vitest";
import { describeReview, reviewedInteraction } from "./permission-review.ts";

const review: PermissionReview = {
  interactionId: InteractionId.parse("interaction-1"),
  mode: "auto-review",
  decision: "deny",
  reason: "Writes outside the workspace",
  reviewer: "ace-risk-policy",
  target: {
    tool: "Shell",
    command: "rm -rf ../shared",
    cwd: "/Users/dev/ace",
    access: "execute",
  },
};

type Notice = Extract<Item, { type: "notice" }>;
const notice = (raw: Notice["raw"]): Notice =>
  Item.parse({
    id: "item-1",
    agentId: "agent-1",
    type: "notice",
    level: "warning",
    text: "Permission review deny: Writes outside the workspace",
    complete: true,
    raw,
    createdAt: 1,
  }) as Notice;

test("a permission-review notice points at the interaction the daemon reviewed", () => {
  expect(reviewedInteraction(notice([{ type: "permission.reviewed", data: review }]))).toBe(
    "interaction-1",
  );
});

test("an ordinary notice, or one whose payload names no interaction, points nowhere", () => {
  expect(reviewedInteraction(notice([]))).toBeUndefined();
  expect(
    reviewedInteraction(notice([{ type: "permission.reviewed", data: { decision: "deny" } }])),
  ).toBeUndefined();
});

test("a denial names who decided, why, and the exact command and directory it judged", () => {
  const view = describeReview(review);
  expect(view.verdict).toBe("Denied by ace");
  expect(view.reason).toBe("Writes outside the workspace");
  expect(view.reviewer).toBe("ace risk policy · Auto-review");
  expect(view.tool).toBe("Shell");
  expect(view.target).toEqual([
    { label: "Command", value: "rm -rf ../shared", code: true },
    { label: "In", value: "/Users/dev/ace", code: true },
    { label: "Access", value: "Runs a command", code: false },
  ]);
});

test("an escalation reads as sent to you, and a long path list is counted rather than listed", () => {
  const paths = Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`);
  const view = describeReview({
    ...review,
    decision: "escalate",
    target: { tool: "Write", paths, access: "write" },
  });
  expect(view.verdict).toBe("Sent to you");
  expect(view.target.filter((line) => line.code).map((line) => line.value)).toEqual(
    paths.slice(0, 6),
  );
  expect(view.target.map((line) => line.value)).toContain("and 3 more");
  expect(view.target[0]?.label).toBe("Paths");
});

test("a review without a target still says what was decided", () => {
  const { target: _target, ...bare } = review;
  const view = describeReview({ ...bare, decision: "approve" });
  expect(view.verdict).toBe("Approved by ace");
  expect(view.tool).toBe("Unknown tool");
  expect(view.target).toEqual([]);
});
