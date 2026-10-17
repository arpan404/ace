import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { createTranslator } from "./index.ts";

function translator() {
  const t = createTranslator({ rootKey: "root" });
  let seq = 0;
  return (data: unknown, dir: "recv" | "send" = "recv"): Fact[] =>
    t.translate({ seq: ++seq, t: seq, dir, channel: "sdk", data }, seq);
}

const assistant = (uuids: string[], parent: string | null = null) => ({
  type: "assistant",
  uuid: `reply-${uuids.join("-")}-${parent ?? "root"}`,
  session_id: "s",
  parent_tool_use_id: parent,
  user_message_uuid: uuids.at(-1),
  user_message_uuids: uuids,
  message: {
    id: `msg-${uuids.join("-")}-${parent ?? "root"}`,
    role: "assistant",
    content: [{ type: "text", text: "working" }],
  },
});

const consumedIds = (facts: Fact[]) =>
  facts.flatMap((fact) => (fact.type === "input.consumed" ? fact.nativeInputIds : []));

test("a reply reports each user message its turn consumed once, as the turn takes it", () => {
  const frame = translator();
  frame({ type: "system", subtype: "init", session_id: "s", model: "m" });
  expect(consumedIds(frame(assistant(["first", "merged"])))).toEqual(["first", "merged"]);
  expect(consumedIds(frame(assistant(["first", "merged"])))).toEqual([]);
  // A steer folded in between tool rounds joins the list on the turn's later replies.
  expect(consumedIds(frame(assistant(["first", "merged", "steer"])))).toEqual(["steer"]);
  // Subagent replies speak for the child's prompt, not the person's sends.
  expect(consumedIds(frame(assistant(["child-prompt"], "toolu_1")))).toEqual([]);
});

test("a steer sent as the turn ended is reported by the next turn, after it starts", () => {
  const frame = translator();
  frame({ type: "system", subtype: "init", session_id: "s", model: "m" });
  frame(assistant(["first"]));
  frame({ type: "result", subtype: "success", session_id: "s", is_error: false, result: "done" });
  const next = frame({ type: "system", subtype: "init", session_id: "s", model: "m" });
  expect(next.filter((fact) => fact.type === "turn.started")).toHaveLength(1);
  expect(consumedIds(next)).toEqual([]);
  expect(consumedIds(frame(assistant(["late-steer"])))).toEqual(["late-steer"]);
});

test("a reply that starts its own turn reports its inputs after that start", () => {
  const frame = translator();
  const facts = frame(assistant(["opened-by-reply"]));
  const started = facts.findIndex((fact) => fact.type === "turn.started");
  expect(started).toBeGreaterThan(-1);
  expect(facts.findIndex((fact) => fact.type === "input.consumed")).toBeGreaterThan(started);
});
