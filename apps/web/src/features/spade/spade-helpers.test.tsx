import { configure, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("a helper is one plain line in the bot's words, with no expander and none of its steps", async () => {
  await spadeApp("/spade/logs", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const logs = spade.addAgent({ id: "logs", name: "Logs" });
    const chat = logs.conversation;
    spade.store(chat, { type: "user_message", text: "Why did CI fail?" });
    spade.store(chat, { type: "reply_started", reply: "r1" });
    spade.store(chat, {
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "j1", name: "helper", arguments: { task: "Read the build log" } }],
    });
    spade.store(chat, { type: "job_started", reply: "r1", job: "j1", name: "helper" });
    spade.store(chat, { type: "step_finished", reply: "r1", text: "A helper is on it." });
    spade.store(chat, { type: "reply_finished", reply: "r1", text: "A helper is on it." });
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Logs" }));
  const line = await chat.findByText("Helper looking into: Read the build log");
  expect(line.closest("summary")).toBeNull();
  expect(chat.queryByRole("button", { name: /Helper looking into/ })).toBeNull();
  expect(chat.queryByRole("list", { name: "Its steps" })).toBeNull();
});
