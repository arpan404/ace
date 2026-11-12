import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

/** The face drawn beside a bot's bubble: its initials, decorative. */
const faceIn = (article: HTMLElement, initials: string) =>
  [...article.querySelectorAll<HTMLElement>("[aria-hidden]")].find(
    (element) => element.textContent === initials,
  );

test("a bot's face sits beside the last bubble of its run, in that bubble's row", async () => {
  // With speech, Read aloud sits under each reply: the face stays by the bubble, not by it.
  vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn() });
  vi.stubGlobal("SpeechSynthesisUtterance", class extends EventTarget {});
  await spadeApp("/spade/garden", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = spade.addAgent({ id: "garden", name: "Garden" });
    spade.store(garden.conversation, { type: "user_message", text: "When do I plant garlic?" });
    spade.reply(garden, "In October.");
    spade.reply(garden, "Mulch it after.");
  });
  const chat = within(await feed("Garden"));
  await chat.findByText("Mulch it after.");
  const articles = chat.getAllByRole("article", { name: "Garden" });
  const [first, last] = [articles.at(-2), articles.at(-1)];
  if (!first || !last) throw new Error("expected two of Garden's bubbles");
  // Only the last of the run has the face, and it shares the bubble's row.
  expect(faceIn(first, "GA")).toBeUndefined();
  const face = faceIn(last, "GA");
  expect(face?.parentElement?.textContent).toBe("GAMulch it after.");
});

test("another bot's run shows its name above the first message and its face by the last", async () => {
  await spadeApp("/spade/garden", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = spade.addAgent({ id: "garden", name: "Garden" });
    spade.addAgent({ id: "weather", name: "Weather" });
    const from = { from_agent: { id: "weather", name: "Weather" } };
    spade.store(garden.conversation, { type: "user_message", text: "Frost tonight.", ...from });
    spade.store(garden.conversation, { type: "user_message", text: "Cover the beds.", ...from });
  });
  const chat = within(await feed("Garden"));
  await chat.findByText("Cover the beds.");
  const runs = chat.getAllByRole("article", { name: "Weather" });
  expect(runs.map((article) => within(article).queryByText("Weather") !== null)).toEqual([
    true,
    false,
  ]);
  expect(runs.map((article) => faceIn(article, "WE") !== undefined)).toEqual([false, true]);
});

test("a failed reply says what went wrong in one plain sentence, and Try again sends the message again", async () => {
  const raw =
    "openrouter/saved/model: Web stream error for model 'saved/model'. Cause: error sending request for url (https://openrouter.ai/api/v1/chat/completions)";
  const { spade } = await spadeApp("/spade/garden", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = api.addAgent({ id: "garden", name: "Garden" });
    api.store(garden.conversation, { type: "user_message", text: "Plan my week" });
    api.store(garden.conversation, { type: "reply_started", reply: "r1" });
    api.store(garden.conversation, {
      type: "reply_failed",
      reply: "r1",
      text: "",
      error: raw,
      kind: "unreachable",
      endpoint: "openrouter",
    });
  });
  const chat = within(await feed("Garden"));
  // Named as the person named the endpoint; the endpoint's own words wait behind Details.
  expect(await chat.findByText("Couldn't reach OpenRouter.")).toBeTruthy();
  expect(chat.queryByText(raw)).toBeNull();
  await userEvent.click(chat.getByRole("button", { name: "Details" }));
  expect(chat.getByLabelText("Details").textContent).toBe(raw);
  await userEvent.click(chat.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-garden/messages")).toEqual([
      { text: "Plan my week" },
    ]),
  );
});
