import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openNew, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const acknowledgement =
  "This bot will run in your Codex CLI on your subscription. Its maker's terms apply to how you " +
  "use it. If they change, Spade may stop offering it. Its terms don't say whether this is allowed.";

const withSubscriptions = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  // What ace lists: only providers it has installed and signed in, with Spade's terms record.
  spade.subscriptions = [
    {
      provider: "codex",
      name: "Codex",
      accounts: [
        { id: "work", label: "Work" },
        { id: "home", label: null },
      ],
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
        { id: "gpt-6.1-luna", name: "GPT-6.1 Luna" },
      ],
      terms: { status: "unclear", acknowledgement, acknowledged: false },
    },
  ];
};

/** A model server on this computer, added after the person's remote endpoint. */
const withLocalModel = (spade: FakeSpadeApi) => {
  spade.endpoints.push({
    id: "ollama",
    name: "Ollama",
    format: "openai-chat",
    base_url: "http://127.0.0.1:11434/v1/",
    local: true,
    header_names: [],
    session_header: null,
    needs_key: false,
    key_set: false,
    key_source: null,
    models: [{ id: "qwen3:8b", name: "Qwen3 8B", source: "typed" }],
  });
};

async function openNewBotPicker() {
  await openNew("New bot");
  await userEvent.click(await screen.findByRole("button", { name: "More settings" }));
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  return screen.findByRole("listbox", { name: "Models" });
}

test("the picker offers models on this computer first and subscriptions last, under their own heading", async () => {
  await spadeApp("/spade", (spade) => {
    withSubscriptions(spade);
    withLocalModel(spade);
  });
  const list = await openNewBotPicker();
  await within(list).findByRole("group", { name: "Codex · Work" });
  const groups = within(list)
    .getAllByRole("group")
    .map((group) => group.getAttribute("aria-label"));
  // The empty choice names what a new bot gets: the local model, first usable.
  expect(groups).toEqual([
    "First usable model",
    "Ollama",
    "OpenRouter",
    "Codex · Work",
    "Codex · home",
  ]);
  expect(within(list).getByRole("group", { name: "First usable model" }).textContent).toContain(
    "Qwen3 8B",
  );
  const heading = within(list).getByText("Your coding subscriptions");
  const codex = within(list).getByRole("group", { name: "Codex · Work" });
  expect(codex.contains(heading)).toBe(true);
});

test("choosing a subscription says once what it means, and ticking Use it makes the bot on it", async () => {
  const { spade } = await spadeApp("/spade", withSubscriptions);
  const list = await openNewBotPicker();
  const work = await within(list).findByRole("group", { name: "Codex · Work" });
  await userEvent.click(within(work).getByRole("option", { name: /GPT-6.1 Luna/ }));
  // Nothing is chosen until the person ticks Use it.
  const asked = await screen.findByRole("group", { name: "Use Codex · Work" });
  expect(asked.textContent).toContain(acknowledgement);
  expect(spade.sent("PUT", "/v1/subscriptions/codex/terms")).toEqual([]);
  await userEvent.click(within(asked).getByRole("checkbox", { name: "Use it" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/subscriptions/codex/terms")).toEqual([{ use: true }]),
  );
  await userEvent.type(screen.getByRole("combobox", { name: "Message New bot" }), "Hi{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({ naming: true, model: "cli:codex@work/gpt-6.1-luna" }),
    ]),
  );
});

test("Back leaves a subscription unchosen", async () => {
  const { spade } = await spadeApp("/spade", withSubscriptions);
  const list = await openNewBotPicker();
  const work = await within(list).findByRole("group", { name: "Codex · Work" });
  await userEvent.click(within(work).getByRole("option", { name: /GPT-6.1 Sol/ }));
  const asked = await screen.findByRole("group", { name: "Use Codex · Work" });
  await userEvent.click(within(asked).getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("listbox", { name: "Models" })).toBeTruthy();
  expect(spade.sent("PUT", "/v1/subscriptions/codex/terms")).toEqual([]);
});

test("a provider whose terms refuse new bots isn't offered", async () => {
  await spadeApp("/spade", (spade) => {
    withSubscriptions(spade);
    const codex = spade.subscriptions[0];
    if (codex) codex.terms = { status: "refused", acknowledgement, acknowledged: false };
  });
  const list = await openNewBotPicker();
  await within(list).findByRole("group", { name: "OpenRouter" });
  expect(within(list).queryByText("Your coding subscriptions")).toBeNull();
  expect(within(list).queryByRole("group", { name: "Codex · Work" })).toBeNull();
});

test("a bot whose subscription's terms no longer allow it offers the person's models in one tap", async () => {
  const line = "Codex's terms no longer allow this. Pick another model for this bot.";
  const { spade } = await spadeApp("/spade", (api) => {
    withSubscriptions(api);
    api.addAgent({
      id: "notes",
      name: "Notes",
      model: "cli:codex@work/gpt-6.1-sol",
      problem: line,
      terms_hold: {
        provider: "codex",
        name: "Codex",
        text: line,
        choices: ["openrouter/saved/model"],
      },
    });
  });
  await userEvent.click(await botRow("Notes"));
  const card = await screen.findByRole("group", { name: "Notes waits for another model" });
  expect(card.textContent).toContain(line);
  await userEvent.click(within(card).getByRole("button", { name: /Saved model/ }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/notes")).toEqual([{ model: "openrouter/saved/model" }]),
  );
  await waitFor(() =>
    expect(screen.queryByRole("group", { name: "Notes waits for another model" })).toBeNull(),
  );
});

test("a bot whose subscription can't run says the next step in its row", async () => {
  await spadeApp("/spade", (spade) => {
    withSubscriptions(spade);
    spade.addAgent({
      name: "Notes",
      model: "cli:codex@work/gpt-6.1-sol",
      problem: "Codex is signed out. Sign in to it in ace, then send again.",
      last_message: { from: "person", text: "Hi", at: 1, from_agent: null },
    });
  });
  const row = await botRow("Notes");
  expect(row.textContent).toContain("Sign in to Codex to go on");
  expect(row.textContent).not.toContain("You: Hi");
});

test("a step its route moved to another model says where it ran and why", async () => {
  await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const bot = api.addAgent({ id: "logs", name: "Logs", model: "ollama/qwen3:8b" });
    api.store(bot.conversation, { type: "user_message", text: "Hi" });
    api.store(bot.conversation, { type: "reply_started", reply: "r1" });
    api.store(bot.conversation, {
      type: "step_served",
      reply: "r1",
      model: "openrouter/saved/model",
      skipped: [{ model: "ollama/qwen3:8b", reason: "unreachable" }],
      line: "Ran on Saved model: the local server was off.",
    });
    api.store(bot.conversation, { type: "step_finished", reply: "r1", text: "Here you go." });
    api.store(bot.conversation, { type: "reply_finished", reply: "r1", text: "Here you go." });
    // A step on the route's first model says nothing.
    api.store(bot.conversation, { type: "user_message", text: "Again" });
    api.store(bot.conversation, { type: "reply_started", reply: "r2" });
    api.store(bot.conversation, { type: "step_served", reply: "r2", model: "ollama/qwen3:8b" });
    api.store(bot.conversation, { type: "step_finished", reply: "r2", text: "Back home." });
    api.store(bot.conversation, { type: "reply_finished", reply: "r2", text: "Back home." });
  });
  await userEvent.click(await botRow("Logs"));
  await screen.findByText("Back home.");
  expect(screen.getAllByText("Ran on Saved model: the local server was off.")).toHaveLength(1);
  expect(screen.queryByText(/Ran on Qwen/)).toBeNull();
});
