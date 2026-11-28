import { configure, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { setShowWork } from "./spade-show-work.ts";

configure({ asyncUtilTimeout: 3000 });

beforeEach(() => setShowWork(false));

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

const intro = "Can you draft a two-line intro?";

test("another bot's message reads as input to this bot, and a finished answer says it went back", async () => {
  await spadeApp("/spade/writing", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    spade.addAgent({ id: "quill", name: "Quill" });
    const writing = spade.addAgent({ id: "writing", name: "Writing" });
    const store = (event: Record<string, unknown>) => spade.store(writing.conversation, event);
    store({
      type: "user_message",
      text: intro,
      from_agent: { id: "quill", name: "Quill", depth: 1 },
    });
    store({ type: "reply_started", reply: "r1" });
    store({ type: "step_finished", reply: "r1", text: "Three days on the river." });
    store({ type: "reply_finished", reply: "r1", text: "Three days on the river." });
  });
  const chat = within(await feed("Writing"));
  await chat.findByText(intro);
  // Under Quill's name, never as the person's own message.
  const from = chat.getByRole("article", { name: "Quill" });
  expect(within(from).getByText(intro)).toBeTruthy();
  expect(chat.queryByRole("article", { name: "You" })).toBeNull();
  expect(chat.getByText("Replied to Quill")).toBeTruthy();
});
