import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

test("a bot's bubbles in a row are one run: its face once, at the run's first bubble, and the run's time under it", async () => {
  // With speech, Read aloud sits under each reply: the face stays at the run's top, not by it.
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
  // A day line, then the person's message, then one run of Garden's two bubbles.
  expect(chat.getByRole("separator", { name: "Today" })).toBeTruthy();
  const [run, ...more] = chat.getAllByRole("article", { name: "Garden" });
  if (!run) throw new Error("expected Garden's run");
  expect(more).toEqual([]);
  const faces = run.querySelectorAll("svg.bot-face");
  expect(faces).toHaveLength(1);
  // The face comes before the run's first words.
  const first = within(run).getByText("In October.");
  expect(faces[0]?.compareDocumentPosition(first)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  // Its reply finished while the person watched: the face shows done, then rests.
  expect(faces[0]?.getAttribute("data-state")).toMatch(/^(done|idle)$/);
  expect(within(run).getByText(/^\d{1,2}:\d{2}/)).toBeTruthy();
});

test("another bot's run shows its name and face once, above its first message", async () => {
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
  expect(runs).toHaveLength(1);
  const run = within(runs[0] ?? document.body);
  expect(run.getAllByText("Weather")).toHaveLength(1);
  expect(runs[0]?.querySelectorAll("svg.bot-face")).toHaveLength(1);
  expect(run.getByText("Frost tonight.")).toBeTruthy();
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
