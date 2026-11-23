import { stageFakeLanes, type FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Errands, a bot running its tasks in lanes (ADR 0217), as the fake stages them. */
function withErrands(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const bot = spade.addAgent({ id: "errands", name: "Errands" });
  stageFakeLanes(
    spade.lanes,
    {
      store: (conversation, event, at) => spade.store(conversation, event, at),
      events: (conversation) => spade.eventsOf(conversation),
      now: () => Date.now(),
    },
    bot.conversation,
  );
  return bot.conversation;
}

async function errands() {
  let main = "";
  const opened = await spadeApp("/spade/errands", (spade) => {
    main = withErrands(spade);
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Errands" }));
  await chat.findByText(/The flights are ready/);
  return { ...opened, main, chat, lane: (name: string) => `${main}-lane-${name}` };
}

test("the tasks pill counts the tasks that haven't ended and opens their list, solid, with each one's state and step", async () => {
  await errands();
  await userEvent.click(
    await screen.findByRole("button", { name: "Tasks: 4 tasks · 1 needs you" }),
  );
  const list = await screen.findByRole("list", { name: "Tasks" });
  const row = (title: string) => within(list).getByRole("button", { name: `Open ${title}` });
  expect(row("Book flights to Lisbon").textContent).toContain("Needs you");
  expect(row("Fix the March invoice").textContent).toContain("Running");
  expect(row("Fix the March invoice").textContent).toContain("2 of 5 · Draft the email to Dana");
  expect(row("Fix the March invoice").textContent).toContain("$0.38");
  expect(row("Compare the three CRM quotes").textContent).toContain(
    "Stopped early: HubSpot's pricing page wouldn't load after three tries",
  );
  expect(row("Clean up the shared drive").textContent).toContain("Done");
  expect(row("Renew the domain").textContent).toContain("Queued");
  // Needs you first, as Spade orders them.
  expect(within(list).getAllByRole("button")[0]?.getAttribute("aria-label")).toBe(
    "Open Book flights to Lisbon",
  );
  // The list is content: on the solid surface, never glass the chat shows through.
  const surface = list.closest("[data-slot=popover-content]");
  expect(surface?.classList.contains("ace-floating-solid")).toBe(true);
  expect(surface?.classList.contains("ace-floating")).toBe(false);
});

test("main's chat says each task's story in quiet lines, and Try again answers a task that stopped early", async () => {
  const { chat, spade, lane } = await errands();
  for (const line of [
    "Started a task: Fix the March invoice · 2 of 5 · Draft the email to Dana",
    "Started a task: Renew the domain · Queued",
    "This is taking a while, so I moved it to its own task: Draft the quarterly note. I'm free to talk.",
    "Sent to Fix the March invoice",
    "Task done: Clean up the shared drive",
    "Task stopped early: Compare the three CRM quotes",
    "Book flights to Lisbon needs you",
  ])
    expect(await chat.findByRole("button", { name: line })).toBeTruthy();
  // The moved reply leaves no empty bubble of its own.
  expect(
    chat.queryByRole("button", { name: /^Started a task: Draft the quarterly note/ }),
  ).toBeNull();

  await userEvent.click(chat.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(spade.sent("POST", `/v1/conversations/${lane("crm")}/retry`)).toEqual([
      { reply: `r-${lane("crm")}` },
    ]),
  );
});

test("a task's line opens the task: its own transcript and composer, goal and plan, and Stop task stops it alone", async () => {
  const { chat, spade, lane } = await errands();
  await userEvent.click(
    await chat.findByRole("button", { name: /^Started a task: Fix the March invoice/ }),
  );
  expect(
    await screen.findByRole("button", {
      name: "Fix the March invoice, a task of Errands: back to Errands",
    }),
  ).toBeTruthy();
  expect(await screen.findByText(/The VAT line used 2% instead of 20%/)).toBeTruthy();
  const panel = within(
    await screen.findByRole("region", { name: "Fix the March invoice: goal and plan" }),
  );
  expect(await panel.findByText("Fix the March invoice and send it to Dana")).toBeTruthy();
  expect(panel.getByText("Draft the email to Dana")).toBeTruthy();
  expect(panel.getByText("$0.38")).toBeTruthy();

  // Writing here goes to this task.
  const composer = await screen.findByRole("combobox", { name: "Message Fix the March invoice" });
  await userEvent.type(composer, "Copy me in too");
  await userEvent.click(await screen.findByRole("button", { name: /^(Send|Steer message)$/ }));
  await waitFor(() =>
    expect(spade.sent("POST", `/v1/conversations/${lane("invoice")}/messages`)).toHaveLength(1),
  );

  await userEvent.click(panel.getByRole("button", { name: "Stop task" }));
  await waitFor(() =>
    expect(spade.sent("POST", `/v1/conversations/${lane("invoice")}/stop`)).toHaveLength(1),
  );
  expect(spade.lanes.lane(lane("invoice"))?.state).toBe("stopped");
  expect(spade.lanes.lane(lane("flights"))?.state).toBe("needs_you");
  await waitFor(() => expect(panel.queryByRole("button", { name: "Stop task" })).toBeNull());
});

test("a task's request leads with the task, says what the step does, and is answered in main", async () => {
  const { chat, spade, main, lane } = await errands();
  const request = await chat.findByRole("group", {
    name: "Book flights to Lisbon wants to pay €412 to TAP Air Portugal",
  });
  await userEvent.click(within(request).getByRole("button", { name: /^Allow/ }));
  await waitFor(() =>
    expect(spade.sent("POST", `/v1/conversations/${main}/approvals/${lane("flights")}.k1`)).toEqual(
      [{ allowed: true, always: false }],
    ),
  );
  expect(spade.lanes.lane(lane("flights"))?.state).toBe("working");
});

test("Settings has a Tasks row that runs tasks on the chat's own model and thinking until set", async () => {
  await spadeApp("/settings/spade/models", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    spade.roles.globalEfforts = { main: "high" };
  });
  const roles = within(await screen.findByRole("region", { name: "Models for other work" }));
  expect(await roles.findByText("Tasks")).toBeTruthy();
  expect(roles.getByText("Default: each bot's own model, as its chat")).toBeTruthy();
  expect(roles.getByText("Same as the chat")).toBeTruthy();
  expect(roles.getByRole("combobox", { name: "Tasks thinking" }).textContent).toContain(
    "Default: medium thinking",
  );
});
