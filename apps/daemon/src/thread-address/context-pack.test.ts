import { expect, it } from "vitest";
import { createTextRedactor } from "@ace/redaction";
import { AgentId, ItemId, type Item } from "@ace/protocol";
import { contextPack } from "./context-pack.ts";

let n = 0;
const message = (role: "user" | "assistant", text: string, extra: Partial<Item> = {}): Item =>
  ({
    id: ItemId.parse(`i${++n}`),
    agentId: AgentId.parse("root"),
    createdAt: n,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text }],
    synthetic: false,
    raw: [],
    ...extra,
  }) as Item;
const thread = {
  title: "Fix login",
  project: "ace",
  branch: "fix-login",
  pullRequest: 12,
};
const redact = createTextRedactor({});

it("the pack holds the thread's title, project, branch, PR, named files and its last 3 turns", () => {
  const items = [1, 2, 3, 4].flatMap((turn) => [
    message("user", `question ${turn}`),
    message("assistant", `answer ${turn}`),
  ]);
  const { pack, shares } = contextPack(thread, ["src/login.ts"], items, redact);
  expect(pack.split("\n")).toEqual([
    'From the ace thread "Fix login" (project ace, branch fix-login, PR #12).',
    "Files the message names: src/login.ts",
    "Its last 3 turns:",
    "person: question 2",
    "agent: answer 2",
    "person: question 3",
    "agent: answer 3",
    "person: question 4",
    "agent: answer 4",
  ]);
  expect(shares).toEqual([
    "this message",
    "the thread's title and project",
    "branch fix-login",
    "PR #12",
    "its last 3 turns",
    "1 file it names",
  ]);
});

it("a secret said in the thread never leaves in the pack", () => {
  const items = [
    message(
      "user",
      "use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
    message("assistant", "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA set"),
  ];
  const { pack } = contextPack(thread, [], items, redact);
  expect(pack).not.toContain("sk-ant-api03-AAAA");
  expect(pack).not.toContain("ghp_AAAA");
});

it("a bot's earlier reply is not passed off as the agent's words", () => {
  const items = [
    message("user", "what broke?"),
    message("assistant", "the bot said this", {
      speaker: { kind: "bot", id: "b", name: "Research", about: "send-1" },
    } as Partial<Item>),
  ];
  const { pack } = contextPack({ title: "Chat" }, [], items, redact);
  expect(pack).toContain("(a chat)");
  expect(pack).not.toContain("the bot said this");
});
