import { expect, test } from "vitest";
import {
  spadeAgentLine,
  spadeCallDetails,
  spadeKeyLine,
  spadeShellCommand,
  type SpadeAgent,
  type SpadeEndpoint,
} from "./index.ts";

const idle: Parameters<typeof spadeAgentLine>[0] = {
  state: "idle",
  waitingFor: undefined,
  status: undefined,
  problem: undefined,
  spending: undefined,
  lastMessage: undefined,
};
const said = (from: "person" | "agent", text: string, fromAgent?: { id: string; name: string }) =>
  ({ from, text, at: 1, fromAgent }) satisfies SpadeAgent["lastMessage"];

test.each([
  [{ state: "waiting", waitingFor: "question" }, "Asked you a question", "needs-you"],
  [{ state: "waiting", waitingFor: "approval" }, "Waiting for you", "needs-you"],
  [{ state: "waiting", status: "Wants to send mail" }, "Wants to send mail", "needs-you"],
  [{ state: "working" }, "Working", "working"],
  [{ state: "working", status: "Reading the docs" }, "Reading the docs", "working"],
  [{ problem: "Signed out of Claude" }, "Signed out of Claude", "needs-you"],
  [{ lastMessage: said("agent", "Done.") }, "Done.", undefined],
  [{ lastMessage: said("person", "Thanks") }, "You: Thanks", undefined],
  [{ lastMessage: said("person", "Go", { id: "b", name: "Scout" }) }, "Scout: Go", undefined],
  [{}, "No messages yet", undefined],
] as const)("a roster row reads %o as %s", (agent, text, tone) => {
  expect(spadeAgentLine({ ...idle, ...agent })).toEqual(tone ? { text, tone } : { text });
});

test("what a bot does now outranks its latest message", () => {
  const line = spadeAgentLine({ ...idle, state: "working", lastMessage: said("agent", "Hi") });
  expect(line.text).toBe("Working");
});

test("only a shell call names its command; other calls show their arguments as Details", () => {
  expect(spadeShellCommand("shell", { command: "ls -la" })).toBe("ls -la");
  expect(spadeShellCommand("send_email", { command: "ls" })).toBeUndefined();
  expect(spadeCallDetails({ to: "a@b.c" })).toBe('{\n  "to": "a@b.c"\n}');
  expect(spadeCallDetails({})).toBeUndefined();
  expect(spadeCallDetails(null)).toBeUndefined();
  expect(spadeCallDetails("x".repeat(20_001))).toHaveLength(20_001);
});

const endpoint: SpadeEndpoint = {
  id: "openai",
  name: "OpenAI",
  format: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  sessionHeader: undefined,
  headerNames: [],
  needsKey: true,
  keySet: false,
  keySource: undefined,
  models: [],
  raw: {},
};

test("a key can be saved only where the machine has a keychain, and removed only from it", () => {
  expect(spadeKeyLine(endpoint, false)).toMatchObject({ canSave: false, canRemove: false });
  expect(spadeKeyLine(endpoint, true)).toMatchObject({
    canSave: true,
    canRemove: false,
    placeholder: "Paste key",
  });
  const saved = { ...endpoint, keySet: true, keySource: "keychain" as const };
  expect(spadeKeyLine(saved, true)).toMatchObject({ canRemove: true, placeholder: "Replace key" });
  const fromEnvironment = { ...endpoint, keySet: true, keySource: "environment" as const };
  expect(spadeKeyLine(fromEnvironment, true)).toMatchObject({ canSave: true, canRemove: false });
  expect(spadeKeyLine({ ...endpoint, keySet: undefined }, true).description).toBe(
    "Checking the keychain…",
  );
});
