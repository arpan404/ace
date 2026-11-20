import { FakeSpadeApi, longHistory } from "@ace/fake-daemon";
import { CommandId, type Command, type CommandPayload } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const threadId = "thread-router";
const research = { kind: "character", v: 1, body: "round", pair: "lagoon" };

/** A thread of the docs project, this machine's Spade with Research, Writer and a club. */
async function open(extra: Parameters<ReturnType<typeof harness>["play"]>[0]["steps"] = []) {
  const app = harness({
    storage: memoryKeyValue(),
    clock: () => Date.now(),
    machines: [{ hostId: "studio", name: "Studio Mac" }],
  });
  app.daemon.spade.status = { state: "ready", version: "0.6.0" };
  const spade = new FakeSpadeApi(app.daemon.spade, () => Date.now());
  spade.addAgent({ id: "research", name: "Research", task: "Finds sources", avatar: research });
  spade.addAgent({
    id: "writer",
    name: "Writer",
    avatar: { kind: "character", v: 1, body: "fox" },
  });
  spade.teams.addGroup({
    id: "launch",
    name: "Launch",
    members: [spade.teams.member("research"), spade.teams.member("writer")],
  });
  const scenario = longHistory(2, threadId);
  scenario.steps.push(...extra);
  app.play(scenario).runUntilBlocked();
  const sent: CommandPayload[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command: Command) => {
    sent.push(command.payload);
    if (command.payload.type === "thread.address") return { commandId: command.id, ok: true };
    return receive(command);
  };
  await app.open(`/t/${threadId}`);
  await waitFor(() => expect(app.client.state).toBe("ready"));
  return {
    app,
    sent,
    message: await screen.findByRole("combobox", { name: "Message" }),
  };
}

const menu = () => screen.findByRole("listbox", { name: "Mention" });
const sections = (list: HTMLElement) =>
  [...list.querySelectorAll("li > p")].map((label) => label.textContent);

test("typing @ lists bots with their faces, clubs with their members' faces, and the fleet's devices", async () => {
  const { message } = await open();
  await userEvent.type(message, "@");
  const list = await menu();
  const bot = await within(list).findByRole("option", { name: /^Research Finds sources/ });
  // Spade draws the faces; its code arrives the first time one is on screen.
  await waitFor(() =>
    expect(bot.querySelector('[data-part="avatar"][data-variant="character"]')).not.toBeNull(),
  );
  const club = within(list).getByRole("option", { name: /^Launch Research and Writer/ });
  await waitFor(() =>
    expect(club.querySelectorAll('[data-part="avatar"]').length).toBeGreaterThan(1),
  );
  await within(list).findByRole("option", { name: /^Studio Mac/ });
  const order = sections(list);
  expect(order.indexOf("Spade bots")).toBeLessThan(order.indexOf("Clubs"));
  expect(order.indexOf("Clubs")).toBeLessThan(order.indexOf("Devices"));
});

test("typing filters across sections, the best match is highlighted, and the arrows move across sections", async () => {
  const { message } = await open();
  await userEvent.type(message, "@wri");
  const list = await menu();
  const writer = await within(list).findByRole("option", { name: /^Writer/ });
  expect(writer.getAttribute("aria-selected")).toBe("true");
  expect(within(list).queryByRole("option", { name: /^Studio Mac/ })).toBeNull();
  await userEvent.clear(message);
  await userEvent.type(message, "@");
  const all = await menu();
  await within(all).findByRole("option", { name: /^Launch/ });
  const options = within(all).getAllByRole("option");
  const before = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
  await userEvent.keyboard("{ArrowDown}");
  const after = within(all)
    .getAllByRole("option")
    .findIndex((option) => option.getAttribute("aria-selected") === "true");
  expect(after).toBe(before + 1);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Mention" })).toBeNull());
});

test("mentioning a bot sends it the message beside the agent's, with the context the line shows", async () => {
  const { message, sent } = await open();
  await userEvent.type(message, "@Resea");
  await userEvent.keyboard("{Enter}");
  expect(message.querySelector("[data-mention-chip]")?.textContent).toContain("@Research");
  await userEvent.type(message, " why does it 500?");
  expect(
    await screen.findByText(/^Shares: this message, the thread's title and project/),
  ).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(sent.some((payload) => payload.type === "thread.address")).toBe(true));
  const send = sent.find((payload) => payload.type === "thread.send");
  const address = sent.find((payload) => payload.type === "thread.address");
  expect(send).toBeDefined();
  expect(address).toMatchObject({
    to: [{ kind: "bot", id: "research", name: "Research" }],
    share: "thread",
  });
});

test("Share only this message sends the bot the words alone", async () => {
  const { message, sent } = await open();
  await userEvent.type(message, "@Launch");
  await userEvent.keyboard("{Enter}");
  await userEvent.type(message, " plan it");
  await userEvent.click(await screen.findByRole("button", { name: "Share only this message" }));
  expect(screen.getByText("Shares: this message")).toBeTruthy();
  await userEvent.type(message, "{Enter}");
  await waitFor(() =>
    expect(sent.find((payload) => payload.type === "thread.address")).toMatchObject({
      to: [{ kind: "club", id: "launch" }],
      share: "message",
    }),
  );
});

test("picking a device sends its structured context", async () => {
  const { message, sent } = await open();
  await userEvent.type(message, "@Studio");
  const studio = await within(await menu()).findByRole("option", { name: /^Studio Mac.*online/ });
  await userEvent.click(studio);
  expect(message.querySelector("[data-mention-chip]")?.textContent).toContain("Studio Mac");
  await userEvent.type(message, " run the build there{Enter}");
  await waitFor(() => expect(sent.some((payload) => payload.type === "thread.send")).toBe(true));
  const send = sent.find((payload) => payload.type === "thread.send");
  expect(send?.type === "thread.send" ? send.context?.items : undefined).toEqual([
    expect.objectContaining({
      type: "device",
      id: "studio",
      name: "Studio Mac",
      machine: { id: "studio", name: "Studio Mac", here: false },
      online: true,
    }),
  ]);
  await waitFor(() =>
    expect(sent.find((payload) => payload.type === "thread.address")).toMatchObject({
      to: [],
      devices: [expect.objectContaining({ id: "studio" })],
    }),
  );
});

test("an offline device can be named: its row and chip say offline, and the agent is told", async () => {
  const { app, message, sent } = await open();
  app.crashMachine("studio");
  await userEvent.type(message, "@Studio");
  const studio = await within(await menu()).findByRole("option", { name: /^Studio Mac.*offline/ });
  await userEvent.click(studio);
  expect(message.querySelector("[data-mention-chip]")?.textContent).toContain("offline");
  await userEvent.type(message, " when it's back{Enter}");
  await waitFor(() => expect(sent.some((payload) => payload.type === "thread.send")).toBe(true));
  const send = sent.find((payload) => payload.type === "thread.send");
  expect(send?.type === "thread.send" ? send.context?.items?.[0] : undefined).toMatchObject({
    type: "device",
    online: false,
  });
});

test("a bot's reply appears in the thread under its face and name, beside ace's line", async () => {
  const about = "send-1";
  await open([
    {
      kind: "facts",
      facts: [
        {
          type: "item.upsert",
          agent: "root",
          item: "person-1",
          draft: {
            type: "message",
            role: "user",
            parts: [{ type: "text", text: "@Research why does it 500?" }],
            origin: { kind: "person", commandId: CommandId.parse(about) },
            complete: true,
          },
        },
        {
          type: "item.upsert",
          agent: "root",
          item: "ace-asked:a1",
          draft: {
            type: "notice",
            level: "info",
            text: "Asked Research",
            asked: {
              about,
              to: [
                {
                  to: { kind: "bot", id: "research", name: "Research", avatar: research },
                  state: "answered",
                },
              ],
              devices: [],
              share: "thread",
              shares: ["this message", "its last 3 turns"],
            },
            complete: true,
          },
        },
        {
          type: "item.upsert",
          agent: "root",
          item: "ace-reply:k:0",
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "The session cookie expired." }],
            speaker: { kind: "bot", id: "research", name: "Research", avatar: research, about },
            complete: true,
          },
        },
      ],
    },
  ]);
  const reply = await screen.findByText("The session cookie expired.");
  const row = reply.closest('[data-part="bot-reply"]');
  expect(row?.textContent).toContain("Research");
  await waitFor(() => expect(row?.querySelector('[data-part="avatar"]')).not.toBeNull());
  expect(screen.getByText("Research answered")).toBeTruthy();
  expect(screen.getByText("Shares: this message, its last 3 turns")).toBeTruthy();
  // The person's words draw the bot it named as its chip.
  const bubble = screen.getByText("why does it 500?", { exact: false });
  expect(
    bubble.closest("[data-part='message-user']")?.querySelector("[data-mention-chip]"),
  ).not.toBeNull();
});

test("an app in the list, and the chip it leaves, show the app's own mark", async () => {
  const { app, message } = await open();
  app.daemon.seedServices({
    extensionCatalogs: {
      opencode: [
        {
          id: "linear",
          kind: "mcp-tool",
          name: "create_issue",
          title: "Linear: create issue",
          description: "Make a Linear issue",
          source: { provider: "opencode", scope: "global" },
          invocation: { type: "tool", name: "create_issue", server: "linear" },
        },
      ],
    },
  });
  await userEvent.type(message, "@Linear");
  const option = await within(await menu()).findByRole("option", { name: /^Linear: create issue/ });
  await waitFor(() => expect(option.querySelector('[data-app="linear"] svg')).not.toBeNull());
  await userEvent.click(option);
  await waitFor(() =>
    expect(message.querySelector('[data-mention-chip] [data-app="linear"] svg')).not.toBeNull(),
  );
});

/** Studio Mac's own Spade, with a bot and a club, and a simulator on it. */
function seedStudio(app: Awaited<ReturnType<typeof open>>["app"]) {
  const studio = app.machines.get("studio");
  if (!studio) throw new Error("no Studio Mac");
  studio.spade.status = { state: "ready", version: "0.6.0" };
  const there = new FakeSpadeApi(studio.spade, () => Date.now());
  there.addAgent({ id: "fares", name: "Fares", task: "Watches fares" });
  there.addAgent({ id: "hotels", name: "Hotels", task: "Finds rooms" });
  there.teams.addGroup({
    id: "trips",
    name: "Trips",
    members: [there.teams.member("fares"), there.teams.member("hotels")],
  });
  studio.appDevices.addDevice({
    id: "ios:6F1C0D52-3C3A-4F5B-9C1E-0D6E2B1F7A10",
    platform: "ios",
    name: "iPhone 17",
    state: "booted",
    runtime: "iOS 26.1",
  });
}

test("another machine's bots, clubs and simulators are listed with that machine, and an ask goes to it", async () => {
  const { app, message, sent } = await open();
  seedStudio(app);
  await userEvent.type(message, "@");
  const list = await menu();
  await within(list).findByRole("option", { name: /^Fares Watches fares · on Studio Mac/ });
  within(list).getByRole("option", { name: /^Trips Fares and Hotels · on Studio Mac/ });
  // This machine's bots read as before.
  within(list).getByRole("option", { name: /^Research Finds sources$/ });
  await userEvent.clear(message);
  await userEvent.type(message, "@iPhone");
  await within(await menu()).findByRole("option", {
    name: /^iPhone 17.*simulator · on Studio Mac/,
  });

  await userEvent.clear(message);
  await userEvent.type(message, "@Fares");
  await userEvent.keyboard("{Enter}");
  await userEvent.type(message, " any drops?{Enter}");
  await waitFor(() =>
    expect(sent.find((payload) => payload.type === "thread.address")).toMatchObject({
      to: [
        { kind: "bot", id: "fares", name: "Fares", machine: { id: "studio", name: "Studio Mac" } },
      ],
    }),
  );
});

const waitingAsk = (waiting: boolean) => [
  {
    type: "background.started" as const,
    owner: "ace" as const,
    agent: "root",
    task: "ace-ask:k1",
    kind: "other" as const,
    title: "Research is answering",
    stoppable: true,
  },
  { type: "background.waiting" as const, task: "ace-ask:k1", waiting },
];

test("a bot waiting on the person after an @ ask puts the thread in the Inbox as needing them, until it answers", async () => {
  const { app } = await open([{ kind: "facts", facts: waitingAsk(true) }]);
  const threads = screen.getByRole("navigation", { name: "Projects" });
  const row = () =>
    within(threads)
      .getByRole("link", { name: /^Document the router/ })
      .closest<HTMLElement>("[data-attention]")?.dataset.attention;
  await waitFor(() => expect(row()).toBe("needs-you"));
  // Research answered: the ask's row ends and the thread no longer needs the person.
  app.daemon.apply(threadId, [
    { type: "background.ended", task: "ace-ask:k1", status: "completed" },
  ]);
  await waitFor(() => expect(row()).not.toBe("needs-you"));
});
