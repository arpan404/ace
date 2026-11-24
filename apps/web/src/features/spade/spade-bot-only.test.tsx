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

/** Main's id for its copy of a task's request, read from what main stored: ids are opaque. */
function copyOf(spade: FakeSpadeApi, main: string, lane: string, call: string): string {
  const asked = spade.eventsOf(main).find((event) => {
    const of = event.lane as { task?: unknown; call_id?: unknown } | undefined;
    return of?.task === lane && of.call_id === call;
  });
  if (typeof asked?.call_id !== "string") throw new Error(`main holds no copy of ${call}`);
  return asked.call_id;
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

test("the conversation shows the bot, its messages and its asks, and nothing of its tasks", async () => {
  const { chat } = await errands();
  expect(screen.queryByRole("button", { name: /^Tasks:/ })).toBeNull();
  expect(document.querySelector("[data-lane-card]")).toBeNull();
  for (const words of [
    /Started a task/,
    /taking a while/,
    /^Sent to /,
    /^Task (done|stopped)/,
    /both changed/,
    /Queued/,
  ])
    expect(chat.queryByText(words)).toBeNull();
  expect(chat.queryByRole("button", { name: /^Open / })).toBeNull();
});

test("a task's question and request reach the person as the bot's own, and are answered in main", async () => {
  const { chat, spade, main, lane } = await errands();
  const card = await chat.findByRole("group", {
    name: "Errands asks: Should the revenue section compare against Q2 or against Q3 last year?",
  });
  expect(chat.queryByText(/Draft the quarterly note asks/)).toBeNull();
  await userEvent.type(within(card).getByRole("textbox"), "Against Q2");
  await userEvent.click(within(card).getByRole("button", { name: /^Send/ }));
  await waitFor(() =>
    expect(
      spade.sent(
        "POST",
        `/v1/conversations/${main}/questions/${copyOf(spade, main, lane("quarterly"), "q1")}`,
      ),
    ).toEqual([{ answers: ["Against Q2"] }]),
  );
  const request = await chat.findByRole("group", {
    name: "Errands wants to pay €412 to TAP Air Portugal",
  });
  await userEvent.click(within(request).getByRole("button", { name: /^Allow/ }));
  await waitFor(() =>
    expect(
      spade.sent(
        "POST",
        `/v1/conversations/${main}/approvals/${copyOf(spade, main, lane("flights"), "k1")}`,
      ),
    ).toEqual([{ allowed: true, always: false }]),
  );
});

test("the bot's working line and Stop show while only its children run, and Stop stops all of them", async () => {
  let main = "";
  const opened = await spadeApp("/spade/errands", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    main = spade.addAgent({ id: "errands", name: "Errands" }).conversation;
    for (const name of ["invoice", "note"])
      spade.lanes.start({
        task: `${main}-lane-${name}`,
        main,
        title: `Errand ${name}`,
        words: `Errand ${name}`,
        state: "working",
        plan: [],
        costMicros: 0,
        asks: [],
        moved: false,
        model: "m",
      });
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Errands" }));
  expect(await chat.findByText(/Errands is working on it/)).toBeTruthy();
  // Never as a list of its tasks.
  expect(chat.queryByText(/Errand (invoice|note)/)).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: /^Stop/ }));
  await waitFor(() =>
    expect(opened.spade.sent("POST", `/v1/conversations/${main}/stop`)).toHaveLength(1),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull());
  await waitFor(() => expect(chat.queryByText(/Errands is working on it/)).toBeNull());
});

test("Activity lists no tasks, and Settings words the role as Background work", async () => {
  await spadeApp("/spade/errands?profile=work", (spade) => {
    withErrands(spade);
  });
  await screen.findByRole("feed", { name: "Conversation with Errands" });
  await screen.findByRole("tablist", { name: "Profile" });
  expect(screen.queryByText("Done today")).toBeNull();
  expect(screen.queryByRole("region", { name: "Tasks in Activity" })).toBeNull();
});

test("Settings has a Background work row that runs on the chat's own model and thinking until set", async () => {
  await spadeApp("/settings/spade/models", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    spade.roles.globalEfforts = { main: "high" };
  });
  const roles = within(await screen.findByRole("region", { name: "Roles" }));
  expect(await roles.findByText("Background work")).toBeTruthy();
  expect(roles.getByText("Same as the chat")).toBeTruthy();
  expect(roles.getByRole("combobox", { name: "Background work thinking" }).textContent).toContain(
    "Default: medium thinking",
  );
  expect(roles.queryByText("Tasks")).toBeNull();
});
