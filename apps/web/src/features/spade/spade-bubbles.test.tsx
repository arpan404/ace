import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

test("a bot's bubbles in a row are one run with no face beside them, under one time line", async () => {
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
  // One time line for it all: nothing paused 30 minutes.
  expect(chat.getAllByRole("separator").map((line) => line.textContent)).toEqual([
    expect.stringMatching(/^Today \d{1,2}:\d{2}/),
  ]);
  const [run, ...more] = chat.getAllByRole("article", { name: "Garden" });
  if (!run) throw new Error("expected Garden's run");
  expect(more).toEqual([]);
  expect(within(run).getByText("In October.")).toBeTruthy();
  // A one-to-one chat carries the bot's face in the pill and the working line, never by bubbles.
  expect(run.querySelector("svg.bot-face")).toBeNull();
});

test("each bubble offers its exact time and Copy, and Copy takes the words without their marks", async () => {
  const written = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: written } });
  await spadeApp("/spade/garden", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = spade.addAgent({ id: "garden", name: "Garden" });
    spade.reply(garden, "## Garlic\n- Plant in **October**");
  });
  const chat = within(await feed("Garden"));
  // The marks never show: the heading and bold read as what they mean.
  expect((await chat.findByRole("heading", { name: "Garlic" })).textContent).toBe("Garlic");
  expect(chat.queryByText(/\*\*|##/)).toBeNull();
  const run = chat.getByRole("article", { name: "Garden" });
  expect(within(run).getByText(/^Today \d{1,2}:\d{2}/)).toBeTruthy();
  await userEvent.click(within(run).getByRole("button", { name: "Copy" }));
  expect(written).toHaveBeenCalledWith("Garlic\n\n- Plant in October");
});

test("a code block sits in its own well with its language and a Copy of just the code", async () => {
  const written = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: written } });
  await spadeApp("/spade/garden", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = spade.addAgent({ id: "garden", name: "Garden" });
    spade.reply(garden, "Use the fake clock:\n```ts\nawait clock.advance(5000);\n```");
  });
  const chat = within(await feed("Garden"));
  const code = await chat.findByText("await clock.advance(5000);");
  expect(chat.getByText("ts")).toBeTruthy();
  expect(chat.queryByText(/```/)).toBeNull();
  await userEvent.click(chat.getByRole("button", { name: "Copy code" }));
  expect(written).toHaveBeenCalledWith("await clock.advance(5000);");
  expect(code.closest("pre")).not.toBeNull();
});

test("a reply's steps fold into one line under it that opens to each step", async () => {
  await spadeApp("/spade/garden", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = spade.addAgent({ id: "garden", name: "Garden" });
    const store = (event: Record<string, unknown>) => spade.store(garden.conversation, event);
    store({ type: "user_message", text: "Check the beds" });
    store({ type: "reply_started", reply: "r1" });
    store({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [
        { id: "a", name: "shell", arguments: { command: "ls beds" } },
        { id: "b", name: "shell", arguments: { command: "cat beds/notes" } },
        { id: "c", name: "workspace_write", arguments: { path: "plan.md" } },
      ],
    });
    for (const [id, name] of [
      ["a", "shell"],
      ["b", "shell"],
      ["c", "workspace_write"],
    ])
      store({
        type: "tool_finished",
        reply: "r1",
        call_id: id,
        name,
        content: "",
        is_error: false,
      });
    store({ type: "reply_finished", reply: "r1", text: "The beds are fine." });
  });
  const chat = within(await feed("Garden"));
  const line = await chat.findByText("Ran 2 commands, wrote a file");
  // Tool arguments never show.
  expect(chat.queryByText(/ls beds|plan\.md/)).toBeNull();
  await userEvent.click(line);
  const steps = within(chat.getByRole("list", { name: "Steps" }));
  expect(steps.getAllByRole("listitem").map((step) => step.textContent)).toEqual([
    "Ran a command",
    "Ran a command",
    "Wrote a file",
  ]);
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
