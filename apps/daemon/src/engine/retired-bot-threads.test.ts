import { expect, test } from "vitest";
import { CommandId, ThreadId, type CommandPayload } from "@ace/protocol";
import { hostRefusal } from "./guest-admission.ts";

const id = CommandId.parse("cmd-1");
const threadId = ThreadId.parse("bot-thread-1");
const send: CommandPayload = {
  type: "thread.send",
  threadId,
  input: [{ type: "text", text: "Hello?" }],
};
const rename: CommandPayload = { type: "thread.rename", threadId, title: "Mine now" };
const commands: CommandPayload[] = [
  send,
  { type: "thread.resume", threadId, expectedRevision: 0 },
  { type: "thread.interrupt", threadId, cascade: true },
  rename,
];

test("a Spade bot's old subscription thread refuses every command, so it stays inert", () => {
  for (const payload of commands)
    expect(hostRefusal(id, payload, "spade-bot"), payload.type).toMatchObject({
      ok: false,
      error: "host_thread",
    });
});

test("Spade's host thread still refuses only what would run an agent, and other threads take all", () => {
  expect(hostRefusal(id, send, "spade")).toMatchObject({ ok: false });
  expect(hostRefusal(id, rename, "spade")).toBeUndefined();
  for (const payload of commands) expect(hostRefusal(id, payload, undefined)).toBeUndefined();
});
