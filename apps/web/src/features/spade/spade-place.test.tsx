import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, roster, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const now = () => Date.now();
const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

test("Spade lists first, then bots by latest activity, each with what it does now or its last message", async () => {
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
    expect(list.getAllByRole("link").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Spade.*No messages yet$/),
      expect.stringMatching(/^(IN)?Inbox.*Waiting for you$/),
      expect.stringMatching(/^(GA)?Garden.*You: Water the tomatoes at 6$/),
    ]),
  );
});

test("opening a bot shows its conversation as bubbles from both sides, and none of its tool calls", async () => {
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
  expect((await chat.findByRole("article", { name: "You" })).textContent).toBe(
    "When do I plant garlic?",
  );
  // One reply is one bubble: its words, without the search it ran between them.
  const replies = chat.getAllByRole("article", { name: "Garden" });
  expect(replies).toHaveLength(1);
  expect(replies[0]?.textContent).toContain("Let me check.In October.");
  expect(chat.getByText("October").tagName).toBe("STRONG");
  expect(chat.queryByText(/web/i)).toBeNull();
});

test("while a bot works its face and status show under its last bubble, until the reply ends", async () => {
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
  expect(within(line).getByRole("button", { name: "Stop Spade" })).toBeTruthy();
  spade.reply(main, "Here it is.", "r9");
  await screen.findByText("Here it is.");
  await waitFor(() => expect(screen.queryByText("Reading a page")).toBeNull());
  expect(screen.queryByRole("button", { name: "Stop Spade" })).toBeNull();
});

test("an approval arrives as the bot's bubble, and Allow answers it", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const inbox = api.addAgent({ id: "inbox", name: "Inbox" });
    api.ask(inbox, "k7", "send_email");
  });
  await userEvent.click(await botRow("Inbox"));
  const ask = await screen.findByText("Inbox wants to send an email.");
  const bubble = ask.closest("[role=article]");
  if (!(bubble instanceof HTMLElement)) throw new Error("no bubble");
  await userEvent.click(within(bubble).getByRole("button", { name: "Allow" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-inbox/approvals/k7")).toEqual([
      { allowed: true, always: false },
    ]),
  );
  await waitFor(() => expect(screen.queryByText("Inbox wants to send an email.")).toBeNull());
});

test("editing a bot sends only what changed and says task and model apply from its next reply", async () => {
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
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit bot" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Garden" }));
  expect(dialog.getByText("Task and model changes apply from Garden's next reply.")).toBeTruthy();
  const task = dialog.getByRole("textbox", { name: "Task" });
  await userEvent.clear(task);
  await userEvent.type(task, "Keep the tomatoes alive");
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/garden")).toEqual([{ task: "Keep the tomatoes alive" }]),
  );
});

test("deleting a bot asks first, then removes it and its conversation", async () => {
  const { spade } = await spadeApp("/spade/garden", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.addAgent({ id: "garden", name: "Garden" });
  });
  await feed("Garden");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete bot" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Delete Garden?" }));
  expect(confirm.getByText("This deletes Garden and its whole conversation.")).toBeTruthy();
  expect(spade.sent("DELETE", "/v1/agents/garden")).toEqual([]);
  await userEvent.click(confirm.getByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(spade.agents.map((agent) => agent.id)).toEqual(["main"]));
  await waitFor(async () =>
    expect((await roster()).queryByRole("link", { name: /^Garden/ })).toBeNull(),
  );
});

test("Spade itself can be edited but never deleted", async () => {
  await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  await feed("Spade");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(await screen.findByRole("menuitem", { name: "Edit Spade" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Delete bot" })).toBeNull();
});

test("an approval shows what the call would do on request, as plain text", async () => {
  await spadeApp("/spade/inbox", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const inbox = api.addAgent({ id: "inbox", name: "Inbox" });
    api.ask(inbox, "k7", "send_email", { to: "marta@example.com", body: "<b>Thursday</b> works" });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Details" }));
  const details = await screen.findByLabelText("Details");
  expect(details.textContent).toContain('"to": "marta@example.com"');
  expect(details.textContent).toContain("<b>Thursday</b> works");
  expect(details.querySelector("b")).toBeNull();
});

test("Stop stays while a bot waits on the person", async () => {
  await spadeApp("/spade/inbox", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.ask(api.addAgent({ id: "inbox", name: "Inbox" }), "k7", "send_email");
  });
  await screen.findByText("Inbox wants to send an email.");
  expect(await screen.findByRole("button", { name: "Stop Inbox" })).toBeTruthy();
});
