import { Item, ThreadId, ThreadStatus, type Agent } from "@ace/protocol";
import { expect, test } from "vitest";
import { agentName } from "./agents.ts";
import { threadLiveFact } from "./live-status.ts";

const subagent: Pick<Agent, "origin" | "native"> = {
  origin: "provider_subagent",
  native: { provider: "claude" },
};
const spawn = (detail: { description?: string; agentType?: string; prompt?: string }) =>
  Item.parse({
    type: "tool_call",
    id: "launch",
    agentId: "root",
    createdAt: 1,
    complete: false,
    call: {
      id: "launch",
      agentId: "root",
      kind: "agent.spawn",
      title: "Agent",
      detail: { kind: "agent.spawn", ...detail },
      status: "running",
      startedAt: 1,
      raw: [],
    },
  });
const launch = spawn({
  description: "Swift engine core + speed",
  agentType: "general-purpose",
  prompt: "Build the Swift engine core.\nKeep it fast.",
});

test("a subagent with its own name goes by it, whatever its call says", () => {
  expect(agentName({ ...subagent, name: "Euclid", role: "explorer" }, launch)).toBe("Euclid");
});

test("an unnamed subagent goes by its role before its call's description", () => {
  expect(agentName({ ...subagent, role: "explorer" }, launch)).toBe("explorer");
});

test("an unnamed subagent goes by its spawning call's description", () => {
  expect(agentName(subagent, launch)).toBe("Swift engine core + speed");
});

test("without a description, an unnamed subagent goes by the agent type it was asked for", () => {
  expect(agentName(subagent, spawn({ agentType: "general-purpose", prompt: "Do it" }))).toBe(
    "general-purpose",
  );
});

test("without a description or type, an unnamed subagent goes by its prompt's first words", () => {
  const long = `Count the lines in every file under src ${"and then some more ".repeat(5)}`;
  const name = agentName(subagent, spawn({ prompt: `\n${long}\nsecond line` }));
  expect(name.startsWith("Count the lines in every file under src")).toBe(true);
  expect(name.endsWith("…")).toBe(true);
  expect(name.length).toBeLessThanOrEqual(60);
});

test("a blank name or description counts as none", () => {
  expect(agentName({ ...subagent, name: "  ", role: "" }, spawn({ description: " " }))).toBe(
    "Subagent",
  );
});

test("a subagent is called Subagent only when nothing names it", () => {
  expect(agentName(subagent)).toBe("Subagent");
  expect(agentName(undefined)).toBe("Subagent");
});

test("the main agent goes by its provider, never by its call or name", () => {
  expect(agentName({ origin: "root", native: { provider: "claude" }, name: "x" }, launch)).toBe(
    "Claude Code",
  );
});

test("a delegated child asking for the person is named in the thread's live line", () => {
  const status = ThreadStatus.parse({ state: "needs_you", interactions: 1 });
  const id = ThreadId.parse("child");
  expect(
    threadLiveFact({ status, live: { askingThreads: [{ id, name: "Review build" }] } }),
  ).toEqual({ kind: "child-asking", agent: "Review build" });
  expect(threadLiveFact({ status, live: { askingThreads: [{ id, name: "" }] } })).toEqual({
    kind: "child-asking",
    agent: "Subagent",
  });
});
