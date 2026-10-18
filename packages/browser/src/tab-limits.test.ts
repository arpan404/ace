import { expect, it } from "vitest";
import { tabOpenRefusal } from "./tab-limits.ts";

const opened = (count: number, agentId?: string) =>
  Array.from({ length: count }, () => ({
    openedBy: agentId ? { kind: "agent" as const, agentId } : { kind: "human" as const },
  }));

it("a thread holds sixteen tabs, whoever opened them", () => {
  expect(tabOpenRefusal(opened(15), { kind: "human" })).toBeUndefined();
  expect(tabOpenRefusal(opened(16), { kind: "human" })).toBe("thread");
  expect(tabOpenRefusal(opened(16), { kind: "agent", agentId: "fresh" })).toBe("thread");
});

it("one agent's eight tabs do not count against another agent", () => {
  const tabs = [...opened(8, "busy"), ...opened(2)];
  expect(tabOpenRefusal(tabs, { kind: "agent", agentId: "busy" })).toBe("agent");
  expect(tabOpenRefusal(tabs, { kind: "agent", agentId: "other" })).toBeUndefined();
  expect(tabOpenRefusal(tabs, { kind: "human" })).toBeUndefined();
});
