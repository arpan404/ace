import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openNew, roster, spadeApp, withEndpoint } from "@/test/spade.ts";

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

const names = async () =>
  (await roster())
    .queryAllByRole("link")
    .map((row) => row.querySelector("[data-view-row-title]")?.textContent);

/** Picks a filter option: what the list shows. */
async function show(option: string) {
  await userEvent.click(screen.getByRole("button", { name: /^Show: / }));
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: new RegExp(`^${option}`) }),
  );
  // A radio menu stays open on a pick; Esc closes it.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}
test("the filter shows the bots working, the ones that need the person, or one machine's", async () => {
  await spadeApp("/spade", crew, { machines: [studio] });
  await waitFor(async () =>
    expect(await names()).toEqual(expect.arrayContaining(["Spade", "Scout", "Research"])),
  );

  await show("Working");
  await waitFor(async () => expect(await names()).toEqual(["Scout"]));
  await show("Needs you");
  await waitFor(async () => expect((await names()).toSorted()).toEqual(["Garden", "Inbox"]));
  await show("Studio Mac");
  await waitFor(async () => expect(await names()).toEqual(["Research"]));
  await show("All bots");
  await waitFor(async () => expect(await names()).toHaveLength(5));
});

test("Search finds bots by name and by what they said, and says when nothing matches", async () => {
  await spadeApp("/spade", crew);
  await waitFor(async () => expect(await names()).toHaveLength(4));
  await userEvent.click(screen.getByRole("button", { name: "Search bots and messages" }));
  const field = screen.getByRole("searchbox", { name: "Search bots and messages" });
  await userEvent.type(field, "tomatoes");
  await waitFor(async () => expect(await names()).toEqual(["Garden"]));
  await userEvent.clear(field);
  await userEvent.type(field, "inb");
  await waitFor(async () => expect(await names()).toEqual(["Inbox"]));
  await userEvent.type(field, "zz");
  await (await roster()).findByText("Nothing matches “inbzz”.");
});

test("a row says what the bot uses on its computer, its machine when elsewhere, and a problem as its next step", async () => {
  await spadeApp(
    "/spade",
    (spade) => {
      crew(spade);
      spade.computer.use("scout", { kind: "browser", live: true, title: null, url: null });
      spade.computer.use("scout", { kind: "terminal", live: true, title: null });
    },
    { machines: [studio] },
  );
  const list = await roster();
  const scout = await list.findByRole("link", { name: /^Scout/ });
  // A bot busy on its computer shows no icons for it on its row.
  expect(within(scout).queryByRole("img", { name: /^Using its/ })).toBeNull();
  const research = await list.findByRole("link", { name: /^Research/ });
  expect(research.textContent).toMatch(/Studio Mac$/);
  expect((await list.findByRole("link", { name: /^Garden/ })).textContent).toMatch(
    /Sign in to Codex to go on$/,
  );
});

test("+ offers New bot, New group and Import bot, and an imported bot opens", async () => {
  const { spade } = await spadeApp("/spade", crew);
  await openNew("New bot");
  await screen.findByRole("dialog", { name: "New bot" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await openNew("New group");
  await screen.findByRole("dialog", { name: "New group" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

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
