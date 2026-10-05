import { InteractionId, Item, type PermissionReview } from "@ace/protocol";
import { expect, test } from "vitest";
import { approvalOutcome, offeredOptions } from "./approvals.ts";
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
  expect(view.tool).toBe("Command");
  expect(view.target).toEqual([
    { label: "Command", value: "rm -rf ../shared", code: true },
    { label: "In", value: "~/ace", code: true },
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
  expect(view.tool).toBe("Action");
  expect(view.target).toEqual([]);
});

const approval = (
  state: "pending" | "resolved" | "expired",
  extra: Partial<Parameters<typeof approvalOutcome>[0]> = {},
): Parameters<typeof approvalOutcome>[0] => ({
  state,
  request: {
    kind: "approval",
    title: "Run npm publish --dry-run",
    options: [
      { id: "once", label: "Allow once", kind: "allow_once" },
      { id: "thread", label: "Allow for this thread", kind: "allow_session" },
      { id: "deny", label: "Deny", kind: "deny" },
    ],
  },
  ...extra,
});

test("an approval reads where it stands: waiting, answered by the person, or closed", () => {
  expect(approvalOutcome(approval("pending")).text).toBe("Waiting for your approval");
  expect(
    approvalOutcome(approval("resolved", { resolution: { kind: "approval", optionId: "once" } }))
      .text,
  ).toBe("Approved by you");
  expect(
    approvalOutcome(approval("resolved", { resolution: { kind: "approval", optionId: "thread" } }))
      .text,
  ).toBe("Approved by you for this thread");
  expect(
    approvalOutcome(approval("resolved", { resolution: { kind: "approval", optionId: "deny" } })),
  ).toMatchObject({ text: "Denied by you", tone: "denied" });
  expect(approvalOutcome(approval("expired")).text).toBe("Expired");
});

test("the person's pick shows at once, before the daemon confirms it", () => {
  expect(approvalOutcome(approval("pending"), "once")).toMatchObject({
    state: "sending",
    text: "Approved by you",
  });
});

test("ace's own decision names ace and the mode", () => {
  expect(
    approvalOutcome(approval("resolved", { review: { ...review, decision: "approve" } })).text,
  ).toBe("Approved by ace · auto-review");
});

test("an escalated review stops saying 'Sent to you' once the person answers", () => {
  const escalated = { ...review, decision: "escalate" as const };
  expect(describeReview(escalated).verdict).toBe("Sent to you");
  expect(
    describeReview(
      escalated,
      approval("resolved", { resolution: { kind: "approval", optionId: "once" } }),
    ).verdict,
  ).toBe("Approved by you");
});

test("outside full access, the options the daemon would refuse are not offered", () => {
  const options =
    approval("pending").request.kind === "approval" ? approval("pending").request : undefined;
  const all = options && "options" in options ? options.options : [];
  expect(offeredOptions(all, "auto-review")).toMatchObject({ hidden: 1 });
  expect(offeredOptions(all, "auto-review").options.map((option) => option.id)).toEqual([
    "once",
    "deny",
  ]);
  expect(offeredOptions(all, "full-access").hidden).toBe(0);
});

test("the policy's terse reason is reworded for the person", () => {
  expect(
    describeReview({ ...review, reason: "Provider did not supply an exact action" }).reason,
  ).toBe("ace couldn't see exactly what this does, so it's asking you");
});
