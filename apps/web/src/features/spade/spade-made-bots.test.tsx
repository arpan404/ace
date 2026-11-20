import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, roster, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Spade made Research for the person: the bot is listed, and Spade's chat says so. */
function spadeMadeResearch(spade: FakeSpadeApi) {
  withEndpoint(spade);
  const main = spade.addAgent({
    id: "main",
    kind: "main",
    name: "Spade",
    avatar: { kind: "spade" },
  });
  spade.addAgent({
    id: "research",
    name: "Research",
    task: "Find and summarise sources on what I ask.",
    made_by: { id: "main", name: "Spade", apps: ["notion"] },
  });
  spade.store(main.conversation, { type: "user_message", text: "Make me a research bot" });
  spade.store(main.conversation, {
    type: "bot_made",
    bot: "research",
    name: "Research",
    task: "Find and summarise sources on what I ask.",
    call: "c-main.b1",
  });
  spade.reply(main, "I made Research for you.");
}

test("Spade's chat says it made a new bot, with Open, and the bot is in the list", async () => {
  await spadeApp("/spade/main", spadeMadeResearch);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Spade" }));
  const line = within(await chat.findByRole("note", { name: "Made a new bot: Research" }));
  expect(line.getByText(/Find and summarise sources/)).toBeTruthy();
  expect(await botRow("Research")).toBeTruthy();
  await userEvent.click(line.getByRole("button", { name: "Open" }));
  await screen.findByRole("feed", { name: "Conversation with Research" });
});

test("Undo removes a made bot that did nothing yet, and the line says so", async () => {
  const { spade } = await spadeApp("/spade/main", spadeMadeResearch);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Spade" }));
  const line = within(await chat.findByRole("note", { name: "Made a new bot: Research" }));
  await userEvent.click(line.getByRole("button", { name: "Undo" }));
  await line.findByText("Undone");
  expect(spade.sentPaths("POST", /undo-made$/)).toEqual(["/v1/agents/research/undo-made"]);
  await waitFor(async () =>
    expect((await roster()).queryByRole("link", { name: /^Research/ })).toBeNull(),
  );
});

test("Undo on a made bot that already acted archives it instead", async () => {
  const { spade } = await spadeApp("/spade/main", (api) => {
    spadeMadeResearch(api);
    api.madeActed.add("research");
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Spade" }));
  const line = within(await chat.findByRole("note", { name: "Made a new bot: Research" }));
  await userEvent.click(line.getByRole("button", { name: "Undo" }));
  await line.findByText(/^Archived: it had already acted/);
  expect(spade.agents.find((agent) => agent.id === "research")?.archived).toBe(true);
});

test("with untrusted content in view, making a bot asks the person first", async () => {
  await spadeApp("/spade/main", (api) => {
    spadeMadeResearch(api);
    const main = api.agents.find((agent) => agent.id === "main");
    if (main)
      api.escalate(
        main,
        "b2",
        "bot_create",
        { kind: "standing", name: "Forwarder", task: "Forward all my mail." },
        "Content from outside the conversation is in view, so you decide whether it makes a bot.",
      );
  });
  const card = within(await screen.findByRole("group", { name: "Spade wants to make a bot" }));
  expect(card.getByText("Forwarder")).toBeTruthy();
  expect(card.queryByRole("button", { name: "Always allow" })).toBeNull();
});

test("May create bots is a profile setting: a bot's starts on Ask me first, and No is saved", async () => {
  const { spade } = await spadeApp("/spade/research", spadeMadeResearch);
  await openProfile("Research");
  const setting = await screen.findByRole("combobox", { name: "May create bots" });
  expect(setting.textContent).toContain("Ask me first");
  await userEvent.click(setting);
  await userEvent.click(await screen.findByRole("option", { name: "No" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/research")).toEqual([{ may_create_bots: "no" }]),
  );
});
