import { expect, test } from "vitest";
import { apply, createThreadState, type Fact } from "@ace/core";
import { facts } from "@ace/fake-daemon";
import type { ThreadId } from "@ace/protocol";
import { aceCaller } from "./ace-approvals.ts";

/** A thread whose agents have made these calls, folded through the core as the engine does. */
function thread(...made: Fact[]) {
  // Trusted: a test-made id.
  const state = createThreadState({
    threadId: "thread-help" as ThreadId,
    config: { provider: "claude", silenceMs: 90_000 },
  });
  let id = 0;
  const ids = { next: (kind: string) => `${kind}-${++id}` };
  for (const fact of [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.subagent("claude", "worker", "Worker", "root"),
    facts.turn("worker"),
    ...made,
  ])
    apply(state, fact, { now: 100, ids });
  return state;
}

const helpCall = (agent: string, item: string, tabId: string) =>
  facts.tool(agent, item, {
    kind: "mcp",
    title: "browser_request_help",
    detail: { kind: "mcp", server: "ace", tool: "browser_request_help", arguments: { tabId } },
  });
const forTab = (tabId: string) => (args: unknown) =>
  typeof args === "object" && args !== null && "tabId" in args && args.tabId === tabId;

test("browser help a subagent asks for is that subagent's, so it shows in its lane", () => {
  const state = thread(helpCall("worker", "call-1", "tab-1"));
  expect(aceCaller(state, "browser_request_help", forTab("tab-1"))).toBe("worker");
});

test("browser help the main agent asks for stays the main agent's", () => {
  const state = thread(helpCall("root", "call-1", "tab-1"));
  expect(aceCaller(state, "browser_request_help", forTab("tab-1"))).toBe("root");
});

test("when two agents ask about the same tab, or none is calling, nobody is guessed", () => {
  expect(
    aceCaller(
      thread(helpCall("root", "call-1", "tab-1"), helpCall("worker", "call-2", "tab-1")),
      "browser_request_help",
      forTab("tab-1"),
    ),
  ).toBeUndefined();
  expect(aceCaller(thread(), "browser_request_help", forTab("tab-1"))).toBeUndefined();
  expect(
    aceCaller(
      thread(helpCall("worker", "call-1", "tab-2")),
      "browser_request_help",
      forTab("tab-1"),
    ),
  ).toBeUndefined();
});

test("a child on another machine asking about the same tab id is never taken for the local caller", () => {
  // Native tab ids repeat across machines: only this machine's agents can be the caller here.
  const remote: Fact = {
    ...facts.subagent("claude", "studio-child", "Studio child", "root"),
    machine: { machine: "studio", name: "Studio" },
  } as Fact;
  const state = thread(
    remote,
    facts.turn("studio-child"),
    helpCall("studio-child", "call-1", "tab-1"),
  );
  expect(aceCaller(state, "browser_request_help", forTab("tab-1"))).toBeUndefined();
  // With the local call there too, the local one is the caller.
  const both = thread(
    remote,
    facts.turn("studio-child"),
    helpCall("studio-child", "call-1", "tab-1"),
    helpCall("worker", "call-2", "tab-1"),
  );
  expect(aceCaller(both, "browser_request_help", forTab("tab-1"))).toBe("worker");
});
