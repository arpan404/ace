import { expect, test } from "vitest";
import { approvalOutcome, offeredOptions } from "./approvals.ts";

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

test("provider approval options remain available in every native mode", () => {
  const options =
    approval("pending").request.kind === "approval" ? approval("pending").request : undefined;
  const all = options && "options" in options ? options.options : [];
  expect(offeredOptions(all, "auto")).toMatchObject({ hidden: 0 });
  expect(offeredOptions(all, "auto").options.map((option) => option.id)).toEqual([
    "once",
    "thread",
    "deny",
  ]);
  expect(offeredOptions(all, "plan").hidden).toBe(0);
});
