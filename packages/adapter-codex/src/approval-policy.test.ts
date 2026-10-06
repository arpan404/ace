import { expect, test } from "vitest";
import { reviewPermission } from "@ace/core";
import { setup } from "./translator.test-helper.ts";

test.each([
  { command: "pwd", actions: [{ type: "unknown", command: "rm -rf build" }] },
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
      reviewPermission({
        mode: "auto-review",
        target: request.target,
        paths: [],
        trustedShells: ["/bin/sh"],
      }).decision,
    ).toBe("escalate");
  },
);

test.each([
  {
    changes: [{ path: "src/main.ts", kind: { type: "update" } }],
    paths: ["workspace"] as const,
    decision: "approve",
  },
  {
    changes: [{ path: "src/main.ts", kind: { type: "update", move_path: "../outside.ts" } }],
    paths: ["workspace", "outside"] as const,
    decision: "escalate",
  },
  { changes: [{ path: "src/main.ts", kind: { type: "delete" } }], paths: [], decision: "escalate" },
])(
  "Codex file approvals review every exact destination and leave deletes uncertain",
  ({ changes, paths, decision }) => {
    const h = setup();
    h.start();
    h.item({ id: "edit", type: "fileChange", changes, status: "inProgress" });
    h.recv(
      "item/fileChange/requestApproval",
      { threadId: "native", turnId: "turn", itemId: "edit", grantRoot: null },
      123,
    );
    const request = h.state.interactions["request:number:123"]?.request;
    if (request?.kind !== "approval") throw new Error("Missing file approval");
    expect(
      reviewPermission({
        mode: "auto-review",
        ...(request.target ? { target: request.target } : {}),
        paths,
      }).decision,
    ).toBe(decision);
  },
);
