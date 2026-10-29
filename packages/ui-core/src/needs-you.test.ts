import { Agent, Interaction, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { needsYou } from "./needs-you.ts";

const agent = (id: string, status: AgentStatus, patch: Record<string, unknown> = {}): Agent =>
  Agent.parse({
    id,
    threadId: "thread",
    parentId: id === "root" ? null : "root",
    origin: id === "root" ? "root" : "provider_subagent",
    native: { provider: "claude" },
    fidelity: "full",
    cwd: "/repo",
    status,
    background: false,
    createdAt: 1,
    ...patch,
  });
const approval = (id: string, agentId: string, createdAt: number): Interaction =>
  Interaction.parse({
    id,
    threadId: "thread",
    agentId,
    blocking: true,
    state: "pending",
    createdAt,
    raw: [],
    request: {
      kind: "approval",
      title: "Run bun install",
      options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    },
  });

const titleOnly = (id: string, title: string): Interaction =>
  Interaction.parse({
    ...approval(id, "root", 5),
    request: {
      kind: "approval",
      title,
      options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    },
  });

test("requests come first, oldest first, then failed and silent agents", () => {
  const items = needsYou(
    [
      agent("root", { state: "blocked", on: "human", refs: [] }),
      agent("worker", { state: "failed", error: { kind: "provider", message: "Crashed\nstack" } }),
      agent("quiet", { state: "unresponsive", lastSignalAt: 50 }),
      agent("asker", { state: "blocked", on: "human", refs: [] }),
    ],
    [approval("late", "asker", 20), approval("early", "root", 10)],
  );
  expect(items.map((item) => [item.kind, item.agentId])).toEqual([
    ["request", "root"],
    ["request", "asker"],
    ["failed", "worker"],
    ["stuck", "quiet"],
  ]);
  expect(items[2]).toMatchObject({ message: "Crashed" });
});

test("an approval that names a shell command carries it for the Summary card", () => {
  const shell = Interaction.parse({
    ...approval("cmd", "root", 5),
    request: {
      kind: "approval",
      title: "Run gh pr merge 1065 --squash?",
      target: {
        tool: "Bash",
        access: "execute",
        command: "gh pr merge 1065 --squash",
      },
      options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    },
  });
  const [item] = needsYou([agent("root", { state: "blocked", on: "human", refs: [] })], [shell]);
  expect(item).toMatchObject({ kind: "request", command: "gh pr merge 1065 --squash" });
});

test("a title-only approval reads its command and risk back out of the title", () => {
  const root = [agent("root", { state: "blocked", on: "human", refs: [] })];
  const [install] = needsYou(root, [titleOnly("i", "Run bun install")]);
  expect(install).toMatchObject({ kind: "request", command: "bun install", risk: "medium" });
  const [merge] = needsYou(root, [titleOnly("m", "Run gh pr merge 1065 --squash?")]);
  expect(merge).toMatchObject({ kind: "request", command: "gh pr merge 1065 --squash" });
  expect(merge).not.toHaveProperty("risk");
});

test("a tool approval never mistakes its title for a shell command", () => {
  const script = Interaction.parse({
    ...approval("s", "root", 5),
    request: {
      kind: "approval",
      title: "Run a script on https://example.com",
      target: {
        tool: "browser.evaluate",
        origin: "ace",
        access: "execute",
        input: { url: "https://example.com", mode: "read-only" },
      },
      options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    },
  });
  const [item] = needsYou([agent("root", { state: "blocked", on: "human", refs: [] })], [script]);
  expect(item).not.toHaveProperty("command");
});

test("a non-blocking question its agent keeps working past doesn't need the person yet", () => {
  const question: Interaction = { ...approval("q", "root", 1), blocking: false };
  expect(needsYou([agent("root", { state: "working", activity: "thinking" })], [question])).toEqual(
    [],
  );
});

test("a delegated child waiting on the person shows even though its request lives in its own thread", () => {
  const items = needsYou(
    [
      agent(
        "child",
        { state: "blocked", on: "human", refs: [] },
        { childThreadId: "child-thread" },
      ),
    ],
    [],
  );
  expect(items).toEqual([{ kind: "waiting", agentId: "child" }]);
});
