import type { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { refusalCount, toolRefusal } from "./tool-refusals.ts";

const base = { agentId: "root", createdAt: 1, complete: true, raw: [] };
const refusal = (id: string, text = 'Allowed claude modes: "plan".'): Item =>
  ({
    ...base,
    id,
    type: "notice",
    level: "error",
    code: "delegation_denied",
    title: "Child permissions exceed the parent permission ceiling",
    text,
    raw: [{ type: "ace.agent_control.failed", data: { operation: "delegate_task" } }],
  }) as Item;
const call = (id: string): Item =>
  ({
    ...base,
    id,
    type: "tool_call",
    call: { kind: "mcp", title: "delegate_task", status: "failed", detail: {}, raw: [] },
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

test("a different reason or the agent's words in between start a new row", () => {
  expect(counts([refusal("r1"), refusal("r2", "Other reason.")])).toEqual([1, 1]);
  expect(counts([refusal("r1"), answer("a"), refusal("r2")])).toEqual([1, 1, 1]);
});

test("a report that leads with its own title gives the reason once, without Details", () => {
  const stored = {
    ...(refusal("old") as Extract<Item, { type: "notice" }>),
    raw: [],
    text: "Child permissions exceed the parent permission ceiling. Choose a permission mode allowed by the parent thread.",
    detail: "Choose a permission mode allowed by the parent thread.",
  } as Item;
  expect(toolRefusal(stored)).toMatchObject({
    label: "Delegation refused",
    reason: "Choose a permission mode allowed by the parent thread.",
  });
  expect(toolRefusal(stored)?.detail).toBeUndefined();
});
