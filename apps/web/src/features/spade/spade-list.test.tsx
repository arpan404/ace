import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openNew, roster, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Spade idle, Scout working, Inbox asking, Garden signed out, and Research on the studio. */
function crew(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const scout = spade.addAgent({ id: "scout", name: "Scout" });
  spade.status(scout, "working", "Comparing hotels");
  const inbox = spade.addAgent({ id: "inbox", name: "Inbox" });
  spade.ask(inbox, "k1", "send_email");
  spade.addAgent({
    id: "garden",
    name: "Garden",
    problem: "Codex is signed out. Sign in to it in ace, then send again.",
    last_message: { from: "person", text: "Water the tomatoes", at: 1, from_agent: null },
  });
}

const studio = {
  hostId: "studio",
  name: "Studio Mac",
  seed(spade: FakeSpadeApi) {
    withEndpoint(spade);
    spade.addAgent({
      id: "research",
      name: "Research",
      last_message: { from: "agent", text: "Found 14 papers", at: 1, from_agent: null },
    });
  },
};

/** The dot on a row's face: needs-you, failed or off. */
const dot = async (name: string) =>
  (await botRow(name)).querySelector("[data-face-dot]")?.getAttribute("data-face-dot");

/** The conversation rows' names; the top's Apps link has none. */
const names = async () =>
  (await roster())
    .queryAllByRole("link")
    .map((row) => row.querySelector("[data-view-row-title]")?.textContent)
    .filter((name) => name !== undefined);

test("Spade is the first row, then what needs the person, what works, what failed and the rest, with dots only for asks and failures", async () => {
  await spadeApp("/spade", crew, { machines: [studio] });
  await waitFor(async () =>
    expect(await names()).toEqual(["Spade", "Inbox", "Scout", "Garden", "Research"]),
  );
  expect(await dot("Inbox")).toBe("needs-you");
  expect(await dot("Garden")).toBe("failed");
  // Working shows in the face moving, never a dot.
  expect(await dot("Scout")).toBeUndefined();
  expect(await dot("Research")).toBeUndefined();
  // No time and no machine on a row: its name and one line.
  expect((await botRow("Research")).textContent).toBe("ResearchFound 14 papers");
});

test("Search, the first top button, opens in place, finds conversations by their words, and says when nothing matches", async () => {
  await spadeApp("/spade", crew);
  await waitFor(async () => expect(await names()).toHaveLength(4));
  await userEvent.click(screen.getByRole("button", { name: "Search conversations" }));
  const field = screen.getByRole("searchbox", { name: "Search conversations" });
  expect(document.activeElement).toBe(field);
  await userEvent.type(field, "tomatoes");
  await waitFor(async () => expect(await names()).toEqual(["Spade", "Garden"]));
  await userEvent.clear(field);
  await userEvent.type(field, "inb");
  await waitFor(async () => expect(await names()).toEqual(["Spade", "Inbox"]));
  await userEvent.type(field, "zz");
  await (await roster()).findByText("Nothing matches “inbzz”.");
  // Esc clears the words, then closes the search, and every row is back.
  await userEvent.keyboard("{Escape}");
  expect(field).toHaveProperty("value", "");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("searchbox", { name: "Search conversations" })).toBeNull();
  await waitFor(async () => expect(await names()).toHaveLength(4));
});

test("a failed bot's line is its next step, and the list has no foot row", async () => {
  await spadeApp("/spade", crew);
  expect((await botRow("Garden")).textContent).toMatch(/Sign in to Codex to go on$/);
  expect(screen.queryByRole("link", { name: "Spade settings" })).toBeNull();
});

test("opening a bot that finished unseen marks its conversation seen, and a seen one sends nothing", async () => {
  const { spade } = await spadeApp("/spade", (world) => {
    crew(world);
    const scout = world.agents.find((agent) => agent.id === "scout");
    if (scout) world.status(scout, "idle", null);
    world.addAgent({ id: "news", name: "News", unseen: true });
  });
  const news = await botRow("News");
  const scout = await botRow("Scout");
  await userEvent.click(scout);
  await screen.findByRole("feed", { name: "Conversation with Scout" });
  await userEvent.click(news);
  await screen.findByRole("feed", { name: "Conversation with News" });
  await waitFor(() => expect(spade.sent("PUT", "/v1/conversations/c-news/seen")).toHaveLength(1));
  expect(spade.sent("PUT", "/v1/conversations/c-scout/seen")).toHaveLength(0);
  // The list reads again: News is no longer unseen, so nothing more is sent.
  await waitFor(() =>
    expect(spade.agents.find((agent) => agent.id === "news")?.unseen).toBe(false),
  );
  expect(spade.sent("PUT", "/v1/conversations/c-news/seen")).toHaveLength(1);
});

test("+, the third top button, offers New bot, New group and Import bot, and an imported bot opens", async () => {
  const { spade } = await spadeApp("/spade", crew);
  await openNew("New bot");
  await screen.findByRole("dialog", { name: "New bot" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await openNew("New group");
  // New group opens in place, as a route, not a dialog.
  await screen.findByRole("form", { name: "New group" });
  expect(screen.queryByRole("dialog")).toBeNull();

  await openNew("Import bot…");
  const file = new File(
    [JSON.stringify({ format: "spade-bot", name: "Pilot", task: "Fly" })],
    "pilot.json",
    {
      type: "application/json",
    },
  );
  fireEvent.change(screen.getByLabelText("Bot file to import"), { target: { files: [file] } });
  await waitFor(() => expect(spade.sent("POST", "/v1/agents/import")).toHaveLength(1));
  await screen.findByRole("feed", { name: "Conversation with Pilot" });
});
