import type { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { transcriptRowContent } from "./mobile-transcript.ts";
import { refusalCount, toolRefusal } from "./tool-refusals.ts";
import { describeStep } from "./work-log.ts";

const base = { agentId: "root", createdAt: 1, complete: true, raw: [] };
/** The daemon's report of a failed agent tool, worded as the public catalog tells the agent. */
const report = (id: string, code: string, title: string, text: string, operation: string): Item =>
  ({
    ...base,
    id,
    type: "notice",
    level: "error",
    code,
    title,
    text,
    raw: [{ type: "ace.agent_control.failed", data: { operation } }],
  }) as Item;
const refusal = (id: string, text = 'Allowed claude modes: "plan".'): Item =>
  report(
    id,
    "delegation_denied",
    "Child permissions exceed the parent permission ceiling",
    text,
    "delegate",
  );
const hint =
  "The tool failed without a public reason. Do not send the identical call again: check the target's current state, change the request, or tell the person.";
const failedRead = (id: string) =>
  report(id, "execution_failed", "Tool execution failed", hint, "thread.read");
const call = (id: string): Item =>
  ({
    ...base,
    id,
    type: "tool_call",
    call: { kind: "mcp", title: "delegate", status: "failed", detail: {}, raw: [] },
  }) as unknown as Item;
const answer = (id: string): Item =>
  ({ ...base, id, type: "message", role: "assistant", parts: [] }) as unknown as Item;

function counts(items: Item[]) {
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const order = items.map((item) => item.id as string);
  return order.map((_, index) => refusalCount(order, index, (id) => byId.get(id)));
}

test("retries of one refused delegation between failed calls count on the first row only", () => {
  expect(
    counts([call("c1"), refusal("r1"), call("c2"), refusal("r2"), call("c3"), refusal("r3")]),
  ).toEqual([1, 3, 1, 0, 1, 0]);
});

test("another refusal or the agent's words in between start a new row", () => {
  expect(counts([refusal("r1"), failedRead("f1")])).toEqual([1, 1]);
  expect(counts([refusal("r1"), answer("a"), refusal("r2")])).toEqual([1, 1, 1]);
});

test("a failed ace tool call never shows the agent hint, on any surface", () => {
  const item = failedRead("read");
  expect(toolRefusal(item)).toMatchObject({ label: "Couldn't read a thread" });
  const shown = [
    JSON.stringify(toolRefusal(item)),
    JSON.stringify(transcriptRowContent(item)),
    describeStep(item).verb,
  ];
  for (const text of shown) {
    expect(text).not.toContain("Do not send");
    expect(text).not.toContain("Tool execution failed");
  }
  expect(transcriptRowContent(item).text).toBe("Couldn't read a thread");
});

test("a refused delegation says why in a person's words, not the catalog's", () => {
  expect(toolRefusal(refusal("r1"))).toMatchObject({
    label: "Delegation refused",
    reason: "The new agent would have more access than this thread",
  });
  expect(JSON.stringify(toolRefusal(refusal("r1")))).not.toContain("permission ceiling");
});

test("a failure code ace has no words for yet reads as what the tool tried", () => {
  const future = report("n", "quota_window_closed", "Some new failure", "Agent hint.", "wait");
  const refused = toolRefusal(future);
  expect(refused?.label).toMatch(/^Couldn't /);
  expect(JSON.stringify(refused)).not.toMatch(/Some new failure|Agent hint/);
});
