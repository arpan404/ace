import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("a helper is one line in the bot's words that opens to the helper's own steps", async () => {
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
    spade.addHelper(chat, { job: "j1", conversation: "h1", task: "Read the build log" });
    spade.store("h1", { type: "user_message", text: "Read the build log" });
    spade.store("h1", { type: "reply_started", reply: "r1" });
    spade.store("h1", {
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "c1", name: "web_fetch", arguments: { url: "https://ci.example" } }],
    });
    spade.store("h1", {
      type: "tool_finished",
      reply: "r1",
      call_id: "c1",
      name: "web_fetch",
      content: "log",
    });
    spade.store("h1", { type: "step_finished", reply: "r1", text: "Step 3 failed." });
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Logs" }));
  const line = await chat.findByText("Helper looking into: Read the build log");
  // Words only: no button chrome on the line, and its steps wait behind it.
  expect(chat.queryByRole("list", { name: "Its steps" })).toBeNull();
  await userEvent.click(line);
  const steps = within(await chat.findByRole("list", { name: "Its steps" }));
  expect(steps.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Read a web page",
    "Step 3 failed.",
  ]);
});
