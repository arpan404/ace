import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { setShowWork } from "./spade-show-work.ts";

configure({ asyncUtilTimeout: 3000 });

beforeEach(() => setShowWork(false));

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

const intro = "Can you draft a two-line intro?";
const answer = "Three days on the river, two on the hills.\nEverything in one place.";

test("a turn's message to another bot is one card whose row opens to the whole exchange", async () => {
  await spadeApp("/spade/quill", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const quill = spade.addAgent({ id: "quill", name: "Quill" });
    spade.addAgent({ id: "writing", name: "Writing" });
    const store = (event: Record<string, unknown>) => spade.store(quill.conversation, event);
    store({ type: "user_message", text: "Get an intro from Writing." });
    store({ type: "reply_started", reply: "r1" });
    store({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "j1", name: "bot_message", arguments: { bot: "writing", text: intro } }],
    });
    store({ type: "tool_started", reply: "r1", call_id: "j1", name: "bot_message" });
    store({ type: "job_started", reply: "r1", job: "j1", name: "bot_message" });
    store({ type: "tool_finished", reply: "r1", call_id: "j1", name: "bot_message", content: "" });
    store({ type: "reply_finished", reply: "r1", text: "Asked." });
    store({
      type: "job_finished",
      job: "j1",
      name: "bot_message",
      content: `Writing answered:\n${answer}`,
    });
  });
  const chat = within(await feed("Quill"));
  // With Show work off, the card stays.
  const card = within(await chat.findByRole("region", { name: "Quill worked with Writing" }));
  expect(card.getByText("Replied: Three days on the river, two on the hills.")).toBeTruthy();
  expect(card.queryByText(intro)).toBeNull();

  const row = card.getByRole("button", { name: "Show the exchange with Writing" });
  await userEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const exchange = within(card.getByRole("list", { name: "The exchange with Writing" }));
  expect(exchange.getByText(intro)).toBeTruthy();
  expect(exchange.getByText(/Everything in one place\./)).toBeTruthy();

  await userEvent.click(card.getByRole("button", { name: "Hide the exchange with Writing" }));
  expect(card.queryByRole("list", { name: "The exchange with Writing" })).toBeNull();
});

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
