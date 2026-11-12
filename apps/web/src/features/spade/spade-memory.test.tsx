import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withTravel = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "travel", name: "Travel" });
};

const texts = (spade: FakeSpadeApi, agent: string | null) =>
  spade.notes.notes.filter((note) => note.agent === agent).map((note) => note.text);

test("a bot's Memory adds, edits in place and deletes its notes through Spade", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    withTravel(api);
    api.notes.add({ text: "Prefers window seats", agent: "travel", source: "bot" });
    api.notes.add({ text: "Lives in Leeds" });
  });
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Travel's memory" }));
  // Its own notes only: the shared ones live in About you.
  const list = within(await dialog.findByRole("list", { name: "Travel's memory" }));
  expect(list.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    "Prefers window seatsDelete",
  ]);

  await userEvent.type(
    dialog.getByRole("textbox", { name: "Add something for Travel to remember" }),
    "Flies from Manchester{Enter}",
  );
  await waitFor(() =>
    expect(texts(spade, "travel")).toEqual(["Prefers window seats", "Flies from Manchester"]),
  );
  await dialog.findByRole("button", { name: "Edit: Flies from Manchester" });
  expect(
    dialog.getByRole<HTMLInputElement>("textbox", { name: "Add something for Travel to remember" })
      .value,
  ).toBe("");

  await userEvent.click(dialog.getByRole("button", { name: "Edit: Prefers window seats" }));
  const field = dialog.getByRole("textbox", { name: "Note" });
  await userEvent.clear(field);
  await userEvent.type(field, "Prefers aisle seats{Enter}");
  await dialog.findByRole("button", { name: "Edit: Prefers aisle seats" });
  expect(spade.sent("PATCH", "/v1/notes/n_1")).toEqual([
    { text: "Prefers aisle seats", updated_at: expect.any(Number) },
  ]);

  await userEvent.click(dialog.getByRole("button", { name: "Delete: Flies from Manchester" }));
  await waitFor(() => expect(texts(spade, "travel")).toEqual(["Prefers aisle seats"]));
  await waitFor(() =>
    expect(dialog.queryByRole("button", { name: "Edit: Flies from Manchester" })).toBeNull(),
  );
  expect(texts(spade, null)).toEqual(["Lives in Leeds"]);
});

test("Settings › Spade › About you lists and adds the notes every bot sees", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    withTravel(api);
    api.notes.add({ text: "Lives in Leeds" });
    api.notes.add({ text: "Prefers window seats", agent: "travel" });
  });
  const list = within(await screen.findByRole("list", { name: "About you" }));
  expect(list.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    "Lives in LeedsDelete",
  ]);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add something about you" }),
    "Vegetarian{Enter}",
  );
  await waitFor(() => expect(texts(spade, null)).toEqual(["Lives in Leeds", "Vegetarian"]));
  expect(spade.sent("POST", "/v1/notes")).toEqual([{ text: "Vegetarian" }]);
});

/** Travel's chat with one finished reply whose memory_save remembered `note`. */
const rememberedChat = (api: FakeSpadeApi) => {
  const travel = withTravel(api);
  const note = api.notes.add({ text: "Prefers window seats", agent: "travel", source: "bot" });
  const c = travel.conversation;
  api.store(c, { type: "user_message", text: "I always pick the window" });
  api.store(c, { type: "reply_started", reply: "r1" });
  api.store(c, {
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [{ id: "k1", name: "memory_save", arguments: { text: note.text } }],
  });
  api.store(c, { type: "tool_started", reply: "r1", call_id: "k1", name: "memory_save" });
  api.store(c, {
    type: "tool_finished",
    reply: "r1",
    call_id: "k1",
    name: "memory_save",
    content: JSON.stringify({ saved: { id: note.id, text: note.text, shared: false } }),
  });
  api.store(c, { type: "step_finished", reply: "r1", text: "Got it." });
  api.store(c, { type: "reply_finished", reply: "r1", text: "Got it." });
};

const openMemory = async () => {
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
  return within(await screen.findByRole("dialog", { name: "Travel's memory" }));
};

test("a note the bot saved reads as one Remembered line that opens it for editing", async () => {
  await spadeApp("/spade/travel", rememberedChat);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Travel" }));
  await chat.findByText("Got it.");
  // One line for the save, nothing else of the tool.
  expect(chat.queryByText(/memory/i)).toBeNull();
  await userEvent.click(chat.getByRole("button", { name: "Remembered: Prefers window seats" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Travel's memory" }));
  expect((await dialog.findByRole<HTMLInputElement>("textbox", { name: "Note" })).value).toBe(
    "Prefers window seats",
  );
});

test("a Remembered line opens the note as Spade has it now, not as last read", async () => {
  const { spade } = await spadeApp("/spade/travel", rememberedChat);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Travel" }));
  await chat.findByText("Got it.");
  // Read the notes once, so the old text is cached.
  const first = await openMemory();
  await first.findByRole("button", { name: "Edit: Prefers window seats" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  spade.notes.rewrite("n_1", "Prefers aisle seats");

  await userEvent.click(chat.getByRole("button", { name: "Remembered: Prefers window seats" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Travel's memory" }));
  // The field's first text is the fresh one: it never shows the cached note.
  expect((await dialog.findByRole<HTMLInputElement>("textbox", { name: "Note" })).value).toBe(
    "Prefers aisle seats",
  );
});

test("an open note follows the bot's changes until typed in, then Save won't overwrite them", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    withTravel(api);
    api.notes.add({ text: "Prefers window seats", agent: "travel", source: "bot" });
  });
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  const dialog = await openMemory();
  await userEvent.click(await dialog.findByRole("button", { name: "Edit: Prefers window seats" }));
  const field = await dialog.findByRole<HTMLInputElement>("textbox", { name: "Note" });
  expect(field.value).toBe("Prefers window seats");

  // Untouched: the bot's newer text replaces it when the list is read again.
  const aisleAt = spade.notes.rewrite("n_1", "Prefers aisle seats").updated_at;
  await userEvent.type(
    dialog.getByRole("textbox", { name: "Add something for Travel to remember" }),
    "Flies from Manchester{Enter}",
  );
  await dialog.findByRole("button", { name: "Edit: Flies from Manchester" });
  await waitFor(() => expect(field.value).toBe("Prefers aisle seats"));

  // Typed in: the draft stays, and Save is refused because the bot changed the note again.
  await userEvent.clear(field);
  await userEvent.type(field, "Prefers front rows");
  spade.notes.rewrite("n_1", "Prefers exit rows");
  await userEvent.type(field, "{Enter}");
  expect((await screen.findAllByText("Changed since you opened it")).length).toBeGreaterThan(0);
  expect(spade.sent("PATCH", "/v1/notes/n_1")).toEqual([
    { text: "Prefers front rows", updated_at: aisleAt },
  ]);
  expect(texts(spade, "travel")).toContain("Prefers exit rows");
  expect(field.value).toBe("Prefers front rows");

  // The draft now stands on the note as it is, so saving again replaces it.
  await userEvent.type(field, "{Enter}");
  await waitFor(() => expect(texts(spade, "travel")).toContain("Prefers front rows"));
  await dialog.findByRole("button", { name: "Edit: Prefers front rows" });
});

test("suggested notes wait under Suggested: Keep moves one into the notes, Dismiss deletes it", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    withTravel(api);
    api.notes.add({ text: "Prefers window seats", agent: "travel", source: "bot" });
    api.notes.suggest({ text: "Flies from Leeds", agent: "travel" });
    api.notes.suggest({ text: "Likes trains", agent: "travel" });
  });
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  const dialog = await openMemory();
  const suggested = within(await dialog.findByRole("list", { name: "Suggested" }));
  expect(
    suggested
      .getAllByRole("listitem")
      .map((row) => row.textContent)
      .toSorted(),
  ).toEqual(["Flies from LeedsKeepDismiss", "Likes trainsKeepDismiss"]);
  const kept = within(dialog.getByRole("list", { name: "Travel's memory" }));
  expect(kept.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    "Prefers window seatsDelete",
  ]);

  await userEvent.click(suggested.getByRole("button", { name: "Keep: Flies from Leeds" }));
  await dialog.findByRole("button", { name: "Edit: Flies from Leeds" });
  expect(spade.sent("POST", "/v1/notes/n_2/accept")).toHaveLength(1);
  expect(suggested.queryByText("Flies from Leeds")).toBeNull();

  await userEvent.click(suggested.getByRole("button", { name: "Dismiss: Likes trains" }));
  await waitFor(() => expect(dialog.queryByRole("list", { name: "Suggested" })).toBeNull());
  expect(texts(spade, "travel").toSorted()).toEqual(["Flies from Leeds", "Prefers window seats"]);
  expect(spade.notes.notes.some((note) => note.suggested)).toBe(false);
});

test("a question from the bot shows as its bubble, and its row says it asked you", async () => {
  await spadeApp("/spade/travel", (api) => {
    const travel = withTravel(api);
    api.question(travel, "q1", "Which airport do you fly from?");
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Travel" }));
  const bubble = await chat.findByRole("article", { name: "Travel" });
  expect(bubble.textContent).toContain("Which airport do you fly from?");
  expect(within(chat.getByRole("status")).getByText("Waiting for you")).toBeTruthy();
  expect((await botRow("Travel")).textContent).toMatch(/Asked you a question$/);
});
