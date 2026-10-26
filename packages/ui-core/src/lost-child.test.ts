import { expect, it } from "vitest";
import { Interaction } from "@ace/protocol";
import { lostChildOf } from "./lost-child.ts";

const ask = (changes: Partial<Interaction>): Interaction =>
  Interaction.parse({
    id: "ask-1",
    threadId: "parent",
    agentId: "root",
    blocking: true,
    request: {
      kind: "approval",
      title: "Lost: Studio is no longer paired; its work there may still be running.",
      options: [{ id: "stop-tracking", label: "Stop tracking", kind: "cancel" }],
    },
    state: "pending",
    createdAt: 1,
    raw: [{ type: "ace.machine.lost", data: { machine: "studio", threadId: "child-a" } }],
    ...changes,
  });

it("the daemon's open request about a lost child names that child", () => {
  expect(lostChildOf(ask({}))).toBe("child-a");
});

it("an answered request, or any other request, names no lost child", () => {
  expect(lostChildOf(ask({ state: "resolved" }))).toBeUndefined();
  expect(lostChildOf(ask({ raw: [{ type: "ace.machine.request", data: {} }] }))).toBeUndefined();
});
