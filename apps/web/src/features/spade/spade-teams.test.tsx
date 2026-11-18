import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { botRow, openNew, roster, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const spadeBot = { id: "main", name: "Spade", machine: null };
const researchBot = { id: "research", name: "Research", machine: null };

/** Spade and Research on this machine, and Writer on Studio Mac. */
function team(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({
    id: "research",
    name: "Research",
    avatar: { kind: "character", v: 1, body: "round", pair: "lagoon" },
  });
}
const studio = {
  hostId: "studio",
  name: "Studio Mac",
  seed: (spade: FakeSpadeApi) =>
    void spade.addAgent({
      id: "writer",
      name: "Writer",
      avatar: { kind: "character", v: 1, body: "fox", pair: "ember" },
    }),
};

/** A group of Spade, Research and Writer (on Studio Mac), with a few messages in it. */
function withGroup(spade: FakeSpadeApi) {
  team(spade);
  const trips = spade.teams.addGroup({
    id: "trips",
    name: "Trips",
    members: [
      spade.teams.member("main"),
      spade.teams.member("research"),
      { agent: "writer", machine: "studio", name: "Writer", avatar: null, away: false },
    ],
    last_message: {
      from: "agent",
      text: "Three options",
      at: 5,
      agent: { id: "research", name: "Research", machine: null },
    },
  });
  const c = trips.conversation;
  spade.store(c, { type: "group_message", run: "u1", text: "Find flights", from: null });
  spade.store(c, { type: "group_asked", run: "u1", ask: "a1", by: null, to: spadeBot, depth: 1 });
  spade.store(c, { type: "reply_started", reply: "r1" });
  spade.store(c, { type: "tool_started", reply: "r1", call_id: "c1", name: "web_search" });
  spade.store(c, {
    type: "group_asked",
    run: "u1",
    ask: "a2",
    by: spadeBot,
    to: researchBot,
    depth: 2,
  });
  spade.store(c, { type: "group_message", run: "u1", text: "Three options", from: researchBot });
  spade.store(c, {
    type: "group_message",
    run: "u1",
    text: "Tuesday is cheapest",
    from: researchBot,
  });
  return trips;
}

/** The pill over a group's chat, then its profile in the side panel. */
async function openGroupProfile(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `${name}: open its profile` }));
  return within(await screen.findByRole("complementary", { name: `${name}'s profile` }));
}

async function openTrips() {
  await userEvent.click(await (await roster()).findByRole("link", { name: /^Trips/ }));
  return within(await screen.findByRole("feed", { name: "Conversation in Trips" }));
}

test("a group's row stacks its members' faces and reads its last message with who said it", async () => {
  await spadeApp("/spade", withGroup, { machines: [studio] });
  const row = await (await roster()).findByRole("link", { name: /^Trips/ });
  expect(row.textContent).toContain("Research: Three options");
  // Writer's face comes from Studio Mac's roster once it answers.
  const faces = () =>
    [...row.querySelectorAll("[data-group-faces] svg.bot-face")].map((face) =>
      face.getAttribute("data-face"),
    );
  await waitFor(() => expect(faces()).toEqual(["round lagoon", "fox ember"]));
});

test("a group's chat shows the person, each member's face and name at the start of its turn, and handoffs as lines, never tool calls", async () => {
  await spadeApp("/spade", withGroup, { machines: [studio] });
  const chat = await openTrips();
  expect(chat.getByRole("article", { name: "You" }).textContent).toBe("Find flights");
  expect(chat.getAllByRole("note").map((line) => line.textContent)).toEqual([
    "Spade asked Research",
  ]);
  // Each member's turn starts with its face and name.
  expect(chat.getAllByRole("article", { name: "Research" }).map((row) => row.textContent)).toEqual([
    "ResearchThree options",
    "Tuesday is cheapest",
  ]);
  const [firstRun, lastRun] = chat.getAllByRole("article", { name: "Research" });
  expect(firstRun?.querySelector("svg.bot-face")?.getAttribute("data-face")).toBe("round lagoon");
  expect(lastRun?.querySelector("svg.bot-face")).toBeNull();
  expect(chat.queryByText(/web_search/)).toBeNull();
});

test("the group's status shows under the last bubble, with the waiting member's chat a click away, and the composer's Stop ends the run", async () => {
  const { spade } = await spadeApp("/spade", withGroup, { machines: [studio] });
  const chat = await openTrips();
  const [trips] = spade.teams.groups;
  if (!trips) throw new Error("no group");
  spade.teams.status(trips, "waiting", "Research is waiting for you");
  const status = await chat.findByRole("status");
  await within(status).findByText("Research is waiting for you");
  // Stop is the composer's.
  expect(within(status).queryByRole("button", { name: /^Stop/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
  await waitFor(() => expect(spade.sent("POST", "/v1/groups/trips/stop")).toEqual([{}]));
  await chat.findByText("Stopped");
});

test("Open <bot> on a group's status opens the member that waits for the person, not the one asked last", async () => {
  const { spade } = await spadeApp("/spade", withGroup, { machines: [studio] });
  const chat = await openTrips();
  const [trips] = spade.teams.groups;
  if (!trips) throw new Error("no group");
  // Writer was asked last, but Research is the one waiting.
  spade.store(trips.conversation, {
    type: "group_asked",
    run: "u1",
    ask: "a3",
    by: spadeBot,
    to: { id: "writer", name: "Writer", machine: "studio" },
    depth: 2,
  });
  // The server names the waiting member by id; the words could say anything.
  spade.teams.status(trips, "waiting", "Research wartet auf dich", researchBot);
  await userEvent.click(await chat.findByRole("button", { name: "Open Research" }));
  await screen.findByRole("feed", { name: "Conversation with Research" });
});

/** Studio Mac with a group of its own, Drafts, led by Writer. */
const studioWithGroup = {
  ...studio,
  seed: (spade: FakeSpadeApi) => {
    studio.seed(spade);
    spade.teams.addGroup({
      id: "drafts",
      name: "Drafts",
      members: [
        spade.teams.member("writer"),
        { agent: "research", machine: "this-mac", name: "Research", avatar: null, away: false },
      ],
      state: "working",
      status: "Writer is answering",
    });
  },
};

test("a group whose machine goes offline stays listed as away, with nothing to post, stop or edit", async () => {
  const { app } = await spadeApp("/spade", team, { machines: [studioWithGroup] });
  await userEvent.click(await (await roster()).findByRole("link", { name: /^Drafts/ }));
  await screen.findByRole("combobox", { name: "Message Drafts" });
  app.crashMachine("studio");
  await waitFor(async () =>
    expect((await (await roster()).findByRole("link", { name: /^Drafts/ })).textContent).toContain(
      "Studio Mac is offline",
    ),
  );
  await screen.findByText("Studio Mac is offline. Drafts is back when it is.");
  expect(screen.queryByRole("combobox", { name: "Message Drafts" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop Drafts" })).toBeNull();
  expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
});

test("a group whose machine's Spade stops answering stays listed as unavailable, not working", async () => {
  const { app } = await spadeApp("/spade", team, { machines: [studioWithGroup] });
  const row = await (await roster()).findByRole("link", { name: /^Drafts/ });
  await waitFor(() => expect(row.textContent).toContain("Writer is answering"));
  const daemon = app.machines.get("studio");
  if (!daemon) throw new Error("no studio");
  daemon.spade.status = { state: "off" };
  // Studio's bots are idle, so its Spade is read every 10 s and a failed read retries once more.
  await waitFor(
    async () =>
      expect(
        (await (await roster()).findByRole("link", { name: /^Drafts/ })).textContent,
      ).toContain("Off on Studio Mac"),
    { timeout: 20_000 },
  );
  await userEvent.click(await (await roster()).findByRole("link", { name: /^Drafts/ }));
  await screen.findByText("Spade isn't running on Studio Mac. Drafts is back when it is.");
  expect(screen.queryByRole("combobox", { name: "Message Drafts" })).toBeNull();
  expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
});

test("a message in a group posts to the group", async () => {
  const { spade } = await spadeApp("/spade", withGroup, { machines: [studio] });
  await openTrips();
  const field = await screen.findByRole("combobox", { name: "Message Trips" });
  await userEvent.type(field, "@Wr");
  const members = await screen.findByRole("listbox", { name: "Members" });
  await userEvent.click(within(members).getByRole("option", { name: "Writer" }));
  await userEvent.type(field, "draft it");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/groups/trips/messages")).toEqual([{ text: "@Writer draft it" }]),
  );
});

test("New group drafts in place: Spade starts picked, members of both machines join, and the picked lead is named", async () => {
  const { spade } = await spadeApp("/spade", team, { machines: [studio] });
  await openNew("New group");
  const draft = within(await screen.findByRole("form", { name: "New group" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(draft.getByRole("checkbox", { name: "Spade" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.type(draft.getByRole("textbox", { name: "Name" }), "Trips");
  await userEvent.click(await draft.findByRole("checkbox", { name: "Research" }));
  await userEvent.click(await draft.findByRole("checkbox", { name: "Writer on Studio Mac" }));
  await userEvent.click(draft.getByRole("combobox", { name: "Lead" }));
  await userEvent.click(await screen.findByRole("option", { name: "Research" }));
  await userEvent.click(draft.getByRole("button", { name: "Make group" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/groups")).toEqual([
      {
        name: "Trips",
        members: [{ agent: "main" }, { agent: "research" }, { agent: "writer", machine: "studio" }],
        lead: "research",
      },
    ]),
  );
  await screen.findByRole("feed", { name: "Conversation in Trips" });
});

test("Make group says why it can't be made yet, beside it and to assistive tech", async () => {
  await spadeApp("/spade", team, { machines: [studio] });
  await openNew("New group");
  const draft = within(await screen.findByRole("form", { name: "New group" }));
  const make = draft.getByRole<HTMLButtonElement>("button", { name: "Make group" });
  const why = () =>
    document.getElementById(make.getAttribute("aria-describedby") ?? "")?.textContent;
  expect(make.disabled).toBe(true);
  expect(why()).toBe("Name the group.");
  await userEvent.type(draft.getByRole("textbox", { name: "Name" }), "Trips");
  expect(make.disabled).toBe(true);
  expect(why()).toBe("Pick at least one more bot.");
  await userEvent.click(await draft.findByRole("checkbox", { name: "Research" }));
  expect(make.disabled).toBe(false);
  expect(why()).toBeUndefined();
  expect(draft.queryByText("Pick at least one more bot.")).toBeNull();
  await userEvent.click(draft.getByRole("checkbox", { name: "Research" }));
  expect(make.disabled).toBe(true);
  expect(draft.getByText("Pick at least one more bot.").id).toBe(
    make.getAttribute("aria-describedby"),
  );
});

test("New group shows no faces until it has two members, and ticking one moves nothing under the pointer", async () => {
  await spadeApp("/spade", team, { machines: [studio] });
  await openNew("New group");
  const form = await screen.findByRole("form", { name: "New group" });
  const draft = within(form);
  const faces = () => form.querySelectorAll("[data-group-faces]").length;
  const rows = () => draft.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"));
  // Spade starts picked, but one bot isn't a group yet: no faces.
  expect(faces()).toBe(0);
  const before = rows();
  // Who answers is there from the start, so a second member inserts nothing above Make group.
  const lead = draft.getByRole("combobox", { name: "Lead" });
  await userEvent.click(await draft.findByRole("checkbox", { name: "Research" }));
  expect(faces()).toBe(1);
  expect(rows()).toEqual(before);
  expect(draft.getByRole("combobox", { name: "Lead" })).toBe(lead);
});

test("making Spade lead in the profile, of a group it isn't in, adds Spade to the members and names it as lead", async () => {
  const { spade } = await spadeApp(
    "/spade",
    (seed) => {
      team(seed);
      seed.teams.addGroup({
        id: "trips",
        name: "Trips",
        members: [
          seed.teams.member("research"),
          { agent: "writer", machine: "studio", name: "Writer", avatar: null, away: false },
        ],
      });
    },
    { machines: [studio] },
  );
  await openTrips();
  const profile = await openGroupProfile("Trips");
  await userEvent.click(profile.getByRole("combobox", { name: "Lead" }));
  await userEvent.click(await screen.findByRole("option", { name: "Spade" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/groups/trips")).toEqual([
      {
        members: [{ agent: "main" }, { agent: "research" }, { agent: "writer", machine: "studio" }],
        lead: "main",
      },
    ]),
  );
});

test("a draft led by a bot of another machine is made there, with this machine's bots named", async () => {
  const { others } = await spadeApp("/spade", team, { machines: [studio] });
  await openNew("New group");
  const draft = within(await screen.findByRole("form", { name: "New group" }));
  await userEvent.type(draft.getByRole("textbox", { name: "Name" }), "Trips");
  await userEvent.click(draft.getByRole("checkbox", { name: "Spade" }));
  await userEvent.click(await draft.findByRole("checkbox", { name: "Research" }));
  await userEvent.click(await draft.findByRole("checkbox", { name: "Writer on Studio Mac" }));
  await userEvent.click(draft.getByRole("combobox", { name: "Lead" }));
  await userEvent.click(await screen.findByRole("option", { name: "Writer on Studio Mac" }));
  await userEvent.click(draft.getByRole("button", { name: "Make group" }));
  await waitFor(() =>
    expect(others.get("studio")?.sent("POST", "/v1/groups")).toEqual([
      {
        name: "Trips",
        members: [{ agent: "research", machine: "this-mac" }, { agent: "writer" }],
        lead: "writer",
      },
    ]),
  );
  await screen.findByRole("feed", { name: "Conversation in Trips" });
});

test("the group's profile adds and removes members, but never the lead or below two", async () => {
  const { spade } = await spadeApp("/spade", withGroup, { machines: [studio] });
  await openTrips();
  const profile = await openGroupProfile("Trips");
  expect(profile.queryByRole("button", { name: "Remove Spade" })).toBeNull();
  await userEvent.click(profile.getByRole("button", { name: "Remove Writer" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/groups/trips")).toEqual([
      { members: [{ agent: "main" }, { agent: "research" }] },
    ]),
  );
  // Two left: neither can go.
  await waitFor(() => expect(profile.queryByRole("button", { name: /^Remove/ })).toBeNull());
  await userEvent.click(profile.getByRole("button", { name: "Add a member" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Writer on Studio Mac" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/groups/trips").at(-1)).toEqual({
      members: [{ agent: "main" }, { agent: "research" }, { agent: "writer", machine: "studio" }],
    }),
  );
});

test("the group's profile renames it in place: Enter saves, Escape puts it back", async () => {
  const { spade } = await spadeApp("/spade", withGroup, { machines: [studio] });
  await openTrips();
  const profile = await openGroupProfile("Trips");
  await userEvent.click(profile.getByRole("button", { name: "Rename Trips" }));
  await userEvent.clear(profile.getByRole("textbox", { name: "Group name" }));
  await userEvent.type(profile.getByRole("textbox", { name: "Group name" }), "Away{Escape}");
  await profile.findByRole("button", { name: "Rename Trips" });
  expect(spade.sent("PATCH", "/v1/groups/trips")).toEqual([]);
  await userEvent.click(profile.getByRole("button", { name: "Rename Trips" }));
  await userEvent.clear(profile.getByRole("textbox", { name: "Group name" }));
  await userEvent.type(profile.getByRole("textbox", { name: "Group name" }), "Lisbon{Enter}");
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/groups/trips")).toEqual([{ name: "Lisbon" }]),
  );
});

test("the group's Library lists its members' files, newest first, each opening in its member's files", async () => {
  await spadeApp(
    "/spade",
    (spade) => {
      const trips = withGroup(spade);
      trips.files = [
        { agent: "research", path: "notes/fares.md", at: Date.now() - 60_000 },
        { agent: "research", path: "sources.md", at: Date.now() - 3_600_000 },
      ];
      spade.files.set("research", { "notes/fares.md": "# Fares\n", "sources.md": "# Sources\n" });
    },
    { machines: [studio] },
  );
  await openTrips();
  const profile = await openGroupProfile("Trips");
  await userEvent.click(profile.getByRole("button", { name: "Library" }));
  const files = await profile.findAllByRole("button", { name: /, by Research$/ });
  expect(files.map((file) => file.getAttribute("aria-label"))).toEqual([
    "fares.md, by Research",
    "sources.md, by Research",
  ]);
  await userEvent.click(profile.getByRole("button", { name: "fares.md, by Research" }));
  await screen.findByRole("feed", { name: "Conversation with Research" });
});

test("a finished group the person hasn't seen is marked seen once they open it at its end", async () => {
  const { spade } = await spadeApp(
    "/spade",
    (seed) => {
      const trips = withGroup(seed);
      trips.unseen = true;
    },
    { machines: [studio] },
  );
  await openTrips();
  await waitFor(() => expect(spade.sent("PUT", "/v1/conversations/c-trips/seen")).toEqual([{}]));
});

test("a group's turn lives in the group: the bot's own chat shows neither the ask nor the answer", async () => {
  await spadeApp("/spade", (spade) => {
    team(spade);
    const research = spade.agents.find((agent) => agent.id === "research");
    if (!research) return;
    spade.store(research.conversation, { type: "user_message", text: "Hello" });
    spade.reply(research, "Hi, what should I look into?");
    spade.store(research.conversation, {
      type: "user_message",
      text: "Find flights",
      from_group: { id: "trips", name: "Trips", run: "u1", ask: "a1", untrusted: false },
    });
    spade.reply(research, "Two flights under $900.");
  });
  await userEvent.click(await botRow("Research"));
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Research" }));
  await chat.findByText("Hi, what should I look into?");
  expect(chat.queryByText("Find flights")).toBeNull();
  expect(chat.queryByText("Two flights under $900.")).toBeNull();
  expect(chat.queryByRole("note", { name: "In Trips" })).toBeNull();
});

test("Duplicate copies the bot and opens the copy; Export saves its file under its name", async () => {
  const saved: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download);
  });
  Object.assign(URL, { createObjectURL: () => "blob:bot", revokeObjectURL: () => {} });
  const { spade } = await spadeApp("/spade", team);
  await userEvent.click(await botRow("Research"));
  await userEvent.click(
    await screen.findByRole("button", { name: /^Research( on .*)?: open its profile$/ }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Export" }));
  await waitFor(() => expect(saved).toEqual(["Research.spade-bot.json"]));
  expect(spade.sent("GET", "/v1/agents/research/export")).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
  await screen.findByRole("feed", { name: "Conversation with Research copy" });
  expect(spade.sent("POST", "/v1/agents/research/duplicate")).toEqual([{}]);
});

test("Import bot from + refuses a file over 6 MB unread, and opens an imported bot", async () => {
  const { spade } = await spadeApp("/spade", team);
  const huge = new File([new Uint8Array(6 * 1024 * 1024 + 1)], "Huge.spade-bot.json", {
    type: "application/json",
  });
  const read = vi.spyOn(huge, "text");
  await openNew("Import bot…");
  fireEvent.change(screen.getByLabelText("Bot file to import"), { target: { files: [huge] } });
  const file = new File(
    [JSON.stringify({ format: "spade-bot", version: 1, name: "Scout", task: "Scout news" })],
    "Scout.spade-bot.json",
    { type: "application/json" },
  );
  await openNew("Import bot…");
  fireEvent.change(screen.getByLabelText("Bot file to import"), { target: { files: [file] } });
  await screen.findByRole("feed", { name: "Conversation with Scout" });
  // Only the file that fits was read and sent.
  expect(read).not.toHaveBeenCalled();
  expect(spade.sent("POST", "/v1/agents/import")).toEqual([
    { format: "spade-bot", version: 1, name: "Scout", task: "Scout news" },
  ]);
});
