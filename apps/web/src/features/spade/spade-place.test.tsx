import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, roster, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const now = () => Date.now();
const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

test("Spade is the list's first row, then each bot with what it asks or its last message", async () => {
  await spadeApp("/spade", (spade) => {
    withEndpoint(spade);
    spade.addAgent({
      id: "garden",
      name: "Garden",
      last_activity: now() - 60_000,
      last_message: { from: "person", text: "Water the tomatoes at 6", at: 0, from_agent: null },
    });
    spade.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      last_activity: 0,
    });
    const inbox = spade.addAgent({ id: "inbox", name: "Inbox", last_activity: now() });
    spade.status(inbox, "waiting", "Waiting for you");
  });
  const list = await roster();
  await waitFor(() =>
    // The rows, not the icon links above them (Apps, plugins and skills).
    expect(
      list
        .getAllByRole("link")
        .filter((link) => !link.hasAttribute("aria-label"))
        .map((row) => row.textContent),
    ).toEqual([
      "SpadeNo messages yet",
      "InboxWaiting for you",
      "GardenYou: Water the tomatoes at 6",
    ]),
  );
});

test("opening a bot shows its conversation as bubbles from both sides, its tool calls only as the steps line", async () => {
  await spadeApp("/spade", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = spade.addAgent({ id: "garden", name: "Garden" });
    spade.store(garden.conversation, { type: "user_message", text: "When do I plant garlic?" });
    spade.store(garden.conversation, { type: "reply_started", reply: "r1" });
    spade.store(garden.conversation, {
      type: "step_finished",
      reply: "r1",
      text: "Let me check.",
      calls: [{ id: "k1", name: "web_search" }],
    });
    spade.store(garden.conversation, {
      type: "tool_started",
      reply: "r1",
      call_id: "k1",
      name: "web_search",
    });
    spade.store(garden.conversation, {
      type: "tool_finished",
      reply: "r1",
      call_id: "k1",
      name: "web_search",
    });
    spade.store(garden.conversation, {
      type: "step_finished",
      reply: "r1",
      text: "In **October**.",
    });
    spade.store(garden.conversation, {
      type: "reply_finished",
      reply: "r1",
      text: "In **October**.",
    });
  });
  await userEvent.click(await botRow("Garden"));
  const chat = within(await feed("Garden"));
  expect(
    within(await chat.findByRole("article", { name: "You" })).getByText("When do I plant garlic?"),
  ).toBeTruthy();
  // One reply is one bubble: its words, with the search it ran between them as one steps line
  // under it, never the call itself.
  const replies = chat.getAllByRole("article", { name: "Garden" });
  expect(replies).toHaveLength(1);
  expect(replies[0]?.textContent).toContain("Let me check.In October.");
  expect(chat.getByText("October").tagName).toBe("STRONG");
  expect(within(replies[0] ?? document.body).getByText("Searched the web")).toBeTruthy();
  expect(chat.queryByText(/web_search/)).toBeNull();
});

test("while a bot works its face, status and time show under its last bubble, with Stop in the composer, until the reply ends", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  const main = spade.agents[0];
  if (!main) throw new Error("no Spade");
  await feed("Spade");
  spade.store(main.conversation, { type: "reply_started", reply: "r9" });
  spade.status(main, "working", "Reading a page");
  const line = await screen.findByRole("status", { name: "" });
  await waitFor(() => expect(line.textContent).toContain("Reading a page"));
  expect(line.querySelector("[data-moving]")).not.toBeNull();
  // Stop is the composer's, never the line's.
  expect(within(line).queryByRole("button")).toBeNull();
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();
  spade.reply(main, "Here it is.", "r9");
  await screen.findByText("Here it is.");
  await waitFor(() => expect(screen.queryByText("Reading a page")).toBeNull());
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
});

test("a request waits in the chat as the bot's bubble, and Allow answers it in place", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const inbox = api.addAgent({ id: "inbox", name: "Inbox" });
    api.ask(inbox, "k7", "send_email");
  });
  await userEvent.click(await botRow("Inbox"));
  const request = await screen.findByRole("group", { name: "Inbox wants to send an email" });
  // The composer stays free while it waits.
  expect(screen.getByRole("combobox", { name: "Message Inbox" })).toBeTruthy();
  await userEvent.click(within(request).getByRole("button", { name: "Allow" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-inbox/approvals/k7")).toEqual([
      { allowed: true, always: false },
    ]),
  );
  // Answered, it stays where it was asked as one line saying so, with nothing left to press.
  const answered = await screen.findByRole("group", {
    name: "Inbox wants to send an email. Allowed",
  });
  expect(within(answered).queryByRole("button", { name: "Allow" })).toBeNull();
});

test("with focus on a waiting request, Escape denies it and Enter allows the next", async () => {
  const { spade } = await spadeApp("/spade/inbox", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const inbox = api.addAgent({ id: "inbox", name: "Inbox" });
    api.ask(inbox, "k1", "shell", { command: "ls" });
  });
  const first = await screen.findByRole("group", { name: "Inbox wants to run a command" });
  first.focus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-inbox/approvals/k1")).toEqual([
      { allowed: false, always: false },
    ]),
  );
  const denied = await screen.findByRole("group", { name: "Inbox wants to run a command. Denied" });
  expect(within(denied).queryByRole("button", { name: "Allow" })).toBeNull();
  const inbox = spade.agents.find((agent) => agent.id === "inbox");
  if (!inbox) throw new Error("no Inbox");
  spade.ask(inbox, "k2", "workspace_write", { path: "notes.md", content: "hi" });
  const next = await screen.findByRole("group", { name: "Inbox wants to write a file" });
  next.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-inbox/approvals/k2")).toEqual([
      { allowed: true, always: false },
    ]),
  );
});

test("editing a bot sends only what changed", async () => {
  const { spade } = await spadeApp("/spade/garden", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.addAgent({
      id: "garden",
      name: "Garden",
      task: "Keep the garden alive",
      model: "openrouter/meta/llama",
    });
  });
  await feed("Garden");
  await openProfile("Garden");
  await userEvent.click(
    await screen.findByRole("button", { name: "Edit the task: Keep the garden alive" }),
  );
  const task = screen.getByRole("textbox", { name: "Task" });
  await userEvent.clear(task);
  await userEvent.type(task, "Keep the tomatoes alive{Meta>}{Enter}{/Meta}");
  await screen.findByRole("button", { name: "Edit the task: Keep the tomatoes alive" });
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/garden")).toEqual([{ task: "Keep the tomatoes alive" }]),
  );
});

test("Esc puts a task being edited back, and nothing is sent", async () => {
  const { spade } = await spadeApp("/spade/garden?profile=details", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.addAgent({ id: "garden", name: "Garden", task: "Keep the garden alive" });
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Edit the task: Keep the garden alive" }),
  );
  const task = screen.getByRole("textbox", { name: "Task" });
  await userEvent.clear(task);
  await userEvent.type(task, "Something else{Escape}");
  await screen.findByRole("button", { name: "Edit the task: Keep the garden alive" });
  expect(spade.sent("PATCH", "/v1/agents/garden")).toEqual([]);
});

test("deleting a bot asks first, then removes it and its conversation", async () => {
  const { spade } = await spadeApp("/spade/garden", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.addAgent({ id: "garden", name: "Garden" });
  });
  await feed("Garden");
  await openProfile("Garden");
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot…" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Delete Garden?" }));
  expect(confirm.getByText("This deletes Garden and its whole conversation.")).toBeTruthy();
  expect(spade.sent("DELETE", "/v1/agents/garden")).toEqual([]);
  await userEvent.click(confirm.getByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(spade.agents.map((agent) => agent.id)).toEqual(["main"]));
  await waitFor(async () =>
    expect((await roster()).queryByRole("link", { name: /^Garden/ })).toBeNull(),
  );
});

test("Spade itself can be changed in its profile but never deleted, and keeps its name and face", async () => {
  await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  await feed("Spade");
  await openProfile("Spade");
  await screen.findByRole("button", { name: "Duplicate" });
  expect(screen.getByRole("button", { name: "Write its task" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete bot…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rename Spade" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Change face" })).toBeNull();
  // Its Library starts with what every bot knows about the person.
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  const headings = await screen.findAllByRole("heading", { level: 3 });
  expect(headings.map((each) => each.textContent).slice(0, 2)).toEqual(["About you", "Notes"]);
});

test("a request is the bot's bubble saying who an email goes to and what, as plain text", async () => {
  await spadeApp("/spade/inbox", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const inbox = api.addAgent({ id: "inbox", name: "Inbox" });
    api.ask(inbox, "k7", "send_email", {
      to: "marta@example.com",
      subject: "Thursday",
      body: "<b>Thursday</b> works",
    });
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Inbox" }));
  const request = await chat.findByRole("group", {
    name: "Inbox wants to send an email to marta@example.com",
  });
  expect(request.textContent).toContain("Subject: Thursday");
  expect(request.textContent).toContain("<b>Thursday</b> works");
  expect(request.querySelector("b")).toBeNull();
  // Never the call's raw JSON.
  expect(request.textContent).not.toContain("{");
});

test("a bot waiting on the person's answer to a request is not working: no Stop in the composer", async () => {
  await spadeApp("/spade/inbox", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.ask(api.addAgent({ id: "inbox", name: "Inbox" }), "k7", "send_email");
  });
  await screen.findByRole("group", { name: "Inbox wants to send an email" });
  expect(await screen.findByRole("button", { name: "Talk with Inbox" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
});
