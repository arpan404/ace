import { expect, it } from "vitest";
import { Interaction } from "@ace/protocol";
import { approvalCopy } from "./approval-copy.ts";
import { lostChildAsk, lostChildCopy, lostChildOf } from "./lost-child.ts";

const ask = (changes: Partial<Interaction>): Interaction =>
  Interaction.parse({
    id: "ask-1",
    threadId: "parent",
    agentId: "root",
    blocking: true,
    request: {
      kind: "approval",
      title: "Lost: Studio is no longer paired; its work there may still be running.",
      options: [
        {
          id: "stop-tracking",
          label: "Stop tracking; its work on Studio may still be running",
          kind: "cancel",
        },
      ],
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

it("a lost child's row says the daemon's sentence and Stop tracking answers with its option", () => {
  expect(lostChildAsk(ask({}))).toEqual({
    interactionId: "ask-1",
    childThreadId: "child-a",
    sentence: "Lost: Studio is no longer paired; its work there may still be running.",
    action: "Stop tracking",
    label: "Stop tracking; its work on Studio may still be running",
    optionId: "stop-tracking",
  });
});

it.each([
  ["answered", ask({ state: "resolved" })],
  ["about no lost child", ask({ raw: [] })],
  [
    "offering no answer",
    ask({
      request: { kind: "approval", title: "Lost: Studio is no longer paired.", options: [] },
    }),
  ],
])("a request %s offers no Stop tracking", (_, interaction) => {
  expect(lostChildAsk(interaction)).toBeUndefined();
});

it("the parent's approval answers a lost child with Stop tracking, never Deny", () => {
  const interaction = ask({});
  const lost = lostChildAsk(interaction);
  if (!lost || interaction.request.kind !== "approval") throw new Error("a lost child's request");
  const plain = approvalCopy(interaction.request);
  expect(plain.decisions.map((decision) => decision.label)).toEqual(["Deny"]);
  const copy = lostChildCopy(plain, lost);
  expect(copy.decisions.map((decision) => [decision.label, decision.option.id])).toEqual([
    ["Stop tracking", "stop-tracking"],
  ]);
  expect(copy.title).toBe(plain.title);
});
