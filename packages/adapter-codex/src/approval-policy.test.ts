import { expect, test } from "vitest";
import { reviewPermission } from "@ace/core";
import { setup } from "./translator.test-helper.ts";

test.each([
  { actions: [{ type: "unknown", command: "pwd" }], decision: "approve", command: "pwd" },
  {
    actions: [
      { type: "unknown", command: "pwd" },
      { type: "unknown", command: "rm -rf build" },
    ],
    decision: "escalate",
    command: "pwd && rm -rf build",
  },
])(
  "Codex approval actions are reviewed together and retain the raw wrapper: $decision",
  ({ actions, decision, command }) => {
    const h = setup();
    const params = {
      threadId: "native",
      itemId: "shell",
      command: "/bin/sh -c 'provider wrapper'",
      commandActions: actions,
      availableDecisions: ["accept", "decline"],
    };
    h.recv("item/commandExecution/requestApproval", params, 1);
    const request = h.state.interactions["request:number:1"]?.request;
    if (request?.kind !== "approval" || !request.target)
      throw new Error("Approval was not translated");
    expect(request.target?.command).toBe(command);
    expect(request.target?.input).toEqual(params);
    expect(
      reviewPermission({ mode: "auto-review", target: request.target, paths: [] }).decision,
    ).toBe(decision);
  },
);
