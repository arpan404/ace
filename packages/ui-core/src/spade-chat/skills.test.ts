import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  parseSpadeProposals,
  spadeBubbles,
  spadeLineChanges,
  spadeView,
  withProposals,
  type SpadeProposal,
} from "./index.ts";

function chat(events: Record<string, unknown>[]) {
  const state = emptySpadeConversation();
  events.forEach((event, seq) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: seq + 1, at: 1, event }));
    if (input) foldSpade(state, input);
  });
  const view = spadeView(state);
  return { bubbles: spadeBubbles(view), entries: view.entries };
}

const proposal = (id: string, callId: string, createdAt = 1): SpadeProposal => ({
  id,
  callId,
  name: "release-notes",
  description: "",
  body: "",
  why: "",
  base: undefined,
  state: "open",
  createdAt,
});

const order = (items: ReturnType<typeof withProposals>) =>
  items.map((item) => (item.kind === "skill" ? `skill ${item.proposal.id}` : item.kind));

describe("skill proposals in the chat", () => {
  const conversation = chat([
    { type: "user_message", text: "Write the notes" },
    { type: "reply_started", reply: "r1" },
    {
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "c1", name: "skill_propose", arguments: {} }],
    },
    { type: "tool_started", reply: "r1", call_id: "c1", name: "skill_propose" },
    { type: "tool_finished", reply: "r1", call_id: "c1", name: "skill_propose", content: "ok" },
    { type: "step_finished", reply: "r1", text: "Noted as a skill." },
    { type: "reply_finished", reply: "r1", text: "Noted as a skill.", cost_micros: 1 },
    { type: "user_message", text: "Thanks" },
  ]);

  test("a proposal sits after the reply that made it, before later messages", () => {
    const items = withProposals(conversation.bubbles, conversation.entries, [proposal("p1", "c1")]);
    expect(order(items)).toEqual(["person", "bot", "skill p1", "person"]);
  });

  test("a proposal whose reply isn't loaded goes at the end", () => {
    const items = withProposals(conversation.bubbles, conversation.entries, [
      proposal("p2", "gone"),
    ]);
    expect(order(items)).toEqual(["person", "bot", "person", "skill p2"]);
  });

  test("proposals that don't parse are left out", () => {
    const body = JSON.stringify({
      proposals: [
        { id: "p1", call_id: "c1", name: "a", body: "x", state: "open", base: null },
        { id: "p2", name: "b", state: "open" },
        { id: "p3", call_id: "c3", name: "c", body: "y", state: "lost" },
      ],
    });
    expect(parseSpadeProposals(body)?.map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("an edit's changed lines", () => {
  test("kept, removed and added lines in order", () => {
    expect(spadeLineChanges("one\ntwo\nthree", "one\n2\nthree\nfour")).toEqual([
      { kind: "same", text: "one" },
      { kind: "removed", text: "two" },
      { kind: "added", text: "2" },
      { kind: "same", text: "three" },
      { kind: "added", text: "four" },
    ]);
  });

  test("texts too long to compare line by line give no diff", () => {
    const long = Array.from({ length: 3000 }, (_, n) => `${n}`).join("\n");
    expect(spadeLineChanges(long, `${long}\nx`)).toBeUndefined();
  });
});
