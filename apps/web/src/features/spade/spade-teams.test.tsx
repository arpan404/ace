import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { botRow, roster, spadeApp, withEndpoint } from "@/test/spade.ts";

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
    avatar: { kind: "generated", initials: "RE", color: "teal" },
  });
}
const studio = {
  hostId: "studio",
  name: "Studio Mac",
  seed: (spade: FakeSpadeApi) =>
    void spade.addAgent({
      id: "writer",
      name: "Writer",
      avatar: { kind: "generated", initials: "WR", color: "violet" },
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

async function openTrips() {
  await userEvent.click(await (await roster()).findByRole("link", { name: /^Trips/ }));
  return within(await screen.findByRole("feed", { name: "Conversation in Trips" }));
}

test("a group's row stacks its members' faces and reads its last message with who said it", async () => {
  await spadeApp("/spade", withGroup, { machines: [studio] });
  const row = await (await roster()).findByRole("link", { name: /^Trips/ });
  expect(row.textContent).toContain("Research: Three options");
  // Writer's face comes from Studio Mac's roster once it answers.
  await waitFor(() => expect(row.querySelector("[data-group-faces]")?.textContent).toBe("REWR"));
});

test("a group's chat shows the person, each member's name and face once per run, and handoffs as lines, never tool calls", async () => {
  await spadeApp("/spade", withGroup, { machines: [studio] });
  const chat = await openTrips();
  expect(chat.getByRole("article", { name: "You" }).textContent).toBe("Find flights");
  expect(chat.getAllByRole("note").map((line) => line.textContent)).toEqual([
    "Spade asked Research",
  ]);
  // The name above the first of the run, the face beside the last.
  expect(chat.getAllByRole("article", { name: "Research" }).map((row) => row.textContent)).toEqual([
    "ResearchThree options",
    "RETuesday is cheapest",
  ]);
  expect(chat.queryByText(/web_search/)).toBeNull();
});

test("the group's status shows under the last bubble, with the waiting member's chat a click away, and Stop ends the run", async () => {
  const { spade } = await spadeApp("/spade", withGroup, { machines: [studio] });
  const chat = await openTrips();
  const [trips] = spade.teams.groups;
  if (!trips) throw new Error("no group");
  spade.teams.status(trips, "waiting", "Research is waiting for you");
  const status = await chat.findByRole("status");
  await within(status).findByText("Research is waiting for you");
  await userEvent.click(within(status).getByRole("button", { name: "Stop Trips" }));
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
      "Away · Studio Mac is offline",
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
  await waitFor(async () =>
    expect((await (await roster()).findByRole("link", { name: /^Drafts/ })).textContent).toContain(
      "Unavailable · Spade isn't running on Studio Mac",
    ),
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

test("New group posts its name, members of both machines and the lead", async () => {
  const { spade } = await spadeApp("/spade", team, { machines: [studio] });
  await userEvent.click(await screen.findByRole("button", { name: "New group" }));
  const form = within(await screen.findByRole("dialog", { name: "New group" }));
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Trips");
  await userEvent.click(await form.findByRole("checkbox", { name: "Research" }));

  await userEvent.click(form.getByRole("checkbox", { name: "Writer on Studio Mac" }));
  await userEvent.click(form.getByRole("combobox", { name: "Lead" }));
  await userEvent.click(await screen.findByRole("option", { name: "Research" }));
  await userEvent.click(form.getByRole("button", { name: "Create group" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/groups")).toEqual([
      {
        name: "Trips",
        members: [{ agent: "research" }, { agent: "writer", machine: "studio" }],
        lead: "research",
      },
    ]),
  );
  await screen.findByRole("feed", { name: "Conversation in Trips" });
});

test("making Spade lead a group it isn't in adds Spade to the members and names it as lead", async () => {
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
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit group" }));
  const form = within(await screen.findByRole("dialog", { name: "Edit Trips" }));
  await userEvent.click(form.getByRole("combobox", { name: "Lead" }));
  await userEvent.click(await screen.findByRole("option", { name: "Spade" }));
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/groups/trips")).toEqual([
      {
        members: [{ agent: "main" }, { agent: "research" }, { agent: "writer", machine: "studio" }],
        lead: "main",
      },
    ]),
  );
});

test("a group on a machine without Spade offers only that machine's bots to lead and names the lead", async () => {
  const { others } = await spadeApp("/spade", team, { machines: [studio] });
  await userEvent.click(await screen.findByRole("button", { name: "New group" }));
  const form = within(await screen.findByRole("dialog", { name: "New group" }));
  await userEvent.click(form.getByRole("combobox", { name: "Lives on" }));
  await userEvent.click(await screen.findByRole("option", { name: "Studio Mac" }));
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Trips");
  await userEvent.click(await form.findByRole("checkbox", { name: "Research on This Mac" }));
  await userEvent.click(form.getByRole("checkbox", { name: "Writer" }));
  await userEvent.click(form.getByRole("combobox", { name: "Lead" }));
  const leads = await screen.findAllByRole("option");
  expect(leads.map((option) => option.textContent)).toEqual(["Writer"]);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(form.getByRole("button", { name: "Create group" }));
  await waitFor(() =>
    expect(others.get("studio")?.sent("POST", "/v1/groups")).toEqual([
      {
        name: "Trips",
        members: [{ agent: "research", machine: "this-mac" }, { agent: "writer" }],
        lead: "writer",
      },
    ]),
  );
});

test("a bot's own chat labels a group's message with the group, not as the person", async () => {
  await spadeApp("/spade", (spade) => {
    team(spade);
    const research = spade.agents.find((agent) => agent.id === "research");
    if (!research) return;
    spade.store(research.conversation, {
      type: "user_message",
      text: "Find flights",
      from_group: { id: "trips", name: "Trips", run: "u1", ask: "a1", untrusted: false },
    });
  });
  await userEvent.click(await botRow("Research"));
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Research" }));
  expect((await chat.findByRole("note", { name: "In Trips" })).textContent).toContain(
    "Find flights",
  );
  expect(chat.queryByRole("article", { name: "You" })).toBeNull();
});

test("starting from a template fills the form and sends the template with the time zone", async () => {
  const { spade } = await spadeApp("/spade", (seed) => {
    team(seed);
    seed.teams.templates.push({
      id: "digest",
      name: "Morning digest",
      blurb: "Reads your feeds each morning",
      task: "Summarise my feeds.",
      color: "amber",
      model_kind: "fast",
      routines: [],
    });
  });
  await userEvent.click(await screen.findByRole("button", { name: "New bot" }));
  const form = within(await screen.findByRole("dialog", { name: "New bot" }));
  await userEvent.click(await form.findByRole("button", { name: /^Morning digest/ }));
  expect(form.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe(
    "Morning digest",
  );
  await userEvent.click(form.getByRole("button", { name: "Create bot" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      {
        name: "Morning digest",
        task: "Summarise my feeds.",
        template: "digest",
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        avatar: { kind: "generated", color: "amber" },
      },
    ]),
  );
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
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Export" }));
  await waitFor(() => expect(saved).toEqual(["Research.spade-bot.json"]));
  expect(spade.sent("GET", "/v1/agents/research/export")).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
  await screen.findByRole("feed", { name: "Conversation with Research copy" });
  expect(spade.sent("POST", "/v1/agents/research/duplicate")).toEqual([{}]);
});

test("Import bot sends the file to the machine, says what it left out, then opens the bot", async () => {
  const { spade } = await spadeApp("/spade", (seed) => {
    team(seed);
    seed.teams.leftOut = ["The Linear app isn't connected here."];
  });
  await userEvent.click(await screen.findByRole("button", { name: "New bot" }));
  const form = within(await screen.findByRole("dialog", { name: "New bot" }));
  const file = new File(
    [JSON.stringify({ format: "spade-bot", version: 1, name: "Scout", task: "Scout news" })],
    "Scout.spade-bot.json",
    { type: "application/json" },
  );
  await userEvent.upload(form.getByLabelText("Bot file"), file);
  const done = within(await screen.findByRole("dialog", { name: "Scout is here" }));
  expect(done.getByRole("list", { name: "Left out" }).textContent).toBe(
    "The Linear app isn't connected here.",
  );
  expect(spade.sent("POST", "/v1/agents/import")).toEqual([
    { format: "spade-bot", version: 1, name: "Scout", task: "Scout news" },
  ]);
  await userEvent.click(done.getByRole("button", { name: "Open Scout" }));
  await screen.findByRole("feed", { name: "Conversation with Scout" });
});

test("Import bot refuses a file over 6 MB without reading or sending it", async () => {
  const { spade } = await spadeApp("/spade", team);
  await userEvent.click(await screen.findByRole("button", { name: "New bot" }));
  const form = within(await screen.findByRole("dialog", { name: "New bot" }));
  const file = new File([new Uint8Array(6 * 1024 * 1024 + 1)], "Huge.spade-bot.json", {
    type: "application/json",
  });
  const read = vi.spyOn(file, "text");
  await userEvent.upload(form.getByLabelText("Bot file"), file);
  expect((await form.findByRole("alert")).textContent).toBe(
    "That file is too big for a bot file (6 MB at most).",
  );
  expect(read).not.toHaveBeenCalled();
  expect(spade.sent("POST", "/v1/agents/import")).toEqual([]);
});

test("an imported bot opens on the machine it was sent to, even if Runs on moved meanwhile", async () => {
  const { spade, others } = await spadeApp(
    "/spade",
    (seed) => {
      team(seed);
      seed.teams.leftOut = ["The Linear app isn't connected here."];
    },
    { machines: [studio] },
  );
  await userEvent.click(await screen.findByRole("button", { name: "New bot" }));
  const form = within(await screen.findByRole("dialog", { name: "New bot" }));
  const file = new File(["{}"], "Scout.spade-bot.json", { type: "application/json" });
  const read = Promise.withResolvers<string>();
  vi.spyOn(file, "text").mockReturnValue(read.promise);
  await userEvent.upload(form.getByLabelText("Bot file"), file);
  // While the file is still being read, the person picks another machine.
  await userEvent.click(form.getByRole("combobox", { name: "Runs on" }));
  await userEvent.click(await screen.findByRole("option", { name: "Studio Mac" }));
  read.resolve(
    JSON.stringify({ format: "spade-bot", version: 1, name: "Scout", task: "Scout news" }),
  );
  const done = within(await screen.findByRole("dialog", { name: "Scout is here" }));
  await userEvent.click(done.getByRole("button", { name: "Open Scout" }));
  await screen.findByRole("feed", { name: "Conversation with Scout" });
  expect(spade.sent("POST", "/v1/agents/import")).toHaveLength(1);
  expect(others.get("studio")?.sent("POST", "/v1/agents/import")).toEqual([]);
});
