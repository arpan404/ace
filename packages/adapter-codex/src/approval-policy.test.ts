import { expect, test } from "vitest";
import { reviewPermission } from "@ace/core";
import { setup } from "./translator.test-helper.ts";

test.each([
  { command: "/bin/sh -c 'pwd > owned'", actions: [{ type: "unknown", command: "pwd" }] },
  { command: "/bin/sh -c 'pwd && rm -rf build'", actions: [{ type: "unknown", command: "pwd" }] },
  { command: "/bin/sh -c 'provider wrapper'", actions: [{ type: "unknown", command: "pwd" }] },
  {
    command: "pwd && rm -rf build",
    actions: [
      { type: "unknown", command: "pwd" },
      { type: "unknown", command: "rm -rf build" },
    ],
  },
])(
  "best-effort actions cannot approve a different executable command: $command",
  ({ command, actions }) => {
    const h = setup();
    const params = {
      threadId: "native",
      itemId: "shell",
      command,
      commandActions: actions,
      availableDecisions: ["accept", "decline"],
    };
    h.recv("item/commandExecution/requestApproval", params, 1);
    const request = h.state.interactions["request:number:1"]?.request;
    if (request?.kind !== "approval" || !request.target)
      throw new Error("Approval was not translated");
    expect(request.target.command).toBe(command);
    expect(request.target.input).toEqual(params);
    expect(
      reviewPermission({ mode: "auto-review", target: request.target, paths: [] }).decision,
    ).toBe("escalate");
  },
);
