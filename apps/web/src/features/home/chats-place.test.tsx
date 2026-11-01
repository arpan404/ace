import { chatScenario, workbench, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

// Saturday 31 October 2026, mid-afternoon, on this device's clock.
const now = new Date(2026, 9, 31, 15).getTime();
const minute = 60_000;
const day = 24 * 60 * minute;

const chatsNav = () => screen.getByRole("navigation", { name: "Chats" });
const threadsNav = () => screen.getByRole("navigation", { name: "Threads" });
const rail = () => screen.getByRole("navigation", { name: "App" });
/** A place in the rail, by the start of its name (a dot's words follow it). */
const place = (name: string) => within(rail()).getByRole("link", { name: new RegExp(`^${name}`) });
/** What a list reads top to bottom: Active and day labels as [label], rows by title. */
const reading = (nav: HTMLElement) =>
  [...nav.querySelectorAll<HTMLElement>("[role=heading], [data-row-focus]")].map((element) =>
    element.getAttribute("role") === "heading"
      ? `[${element.textContent}]`
      : (element
          .getAttribute("aria-label")
          ?.split(". ")[0]
          ?.replace(/, unread$/, "") ?? ""),
  );

const lisbon = chatScenario(
  "trip",
  "Three days in Lisbon",
  "claude",
  "Plan three relaxed days in Lisbon.",
  "Alfama, Belém, then Sintra by train.",
);
const tls = chatScenario(
  "tls",
  "How TLS 1.3 handshakes work",
  "codex",
  "Explain TLS 1.3.",
  "One round trip.",
);
const espresso = chatScenario(
  "espresso",
  "Dialing in espresso",
  "opencode",
  "Sour espresso?",
  "Grind finer first.",
);
const regex = chatScenario("regex", "Regex for semver", "claude", "Semver regex?", "Here it is.");

/** A chat that asks the person to approve a command, as the workbench's retry-budget thread does. */
function askingChat(): Scenario {
  const asks = workbench().find((each) => each.thread.id === "thread-retry-budget");
  if (!asks) throw new Error("Missing the approval scenario");
  const project = "chat-asks";
  return {
    ...asks,
    thread: {
      ...asks.thread,
      id: "thread-chat-asks",
      title: "Clean up my downloads folder",
      workspaceId: project,
      details: {
        workspace: { id: project, name: "Chat", path: `/fake/chats/${project}`, kind: "chat" },
        mode: "local",
      },
    },
  };
}

/** The window's address, to read and to move. */
let history: RouterHistory = createMemoryHistory();
const visit = (path: string) => act(() => history.push(path));
const location = () => history.location;

/** The app on a daemon whose clock this test sets, and a device clock that reads `now`. */
function appAt(clock: () => number) {
  history = createMemoryHistory();
  return harness({ clock, uiClock: () => now, history });
}

/** The workbench's project threads, and chats that last moved `ago` before now. */
function chatsApp(chats: readonly { scenario: Scenario; ago: number }[]) {
  let at = now - 30 * day;
  const app = appAt(() => (at += 1));
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  for (const chat of chats) {
    at = now - chat.ago;
    app.play(chat.scenario).runUntilBlocked();
  }
  at = now;
  return app;
}

const everyDay = () =>
  chatsApp([
    { scenario: espresso, ago: 12 * day },
    { scenario: tls, ago: 3 * day },
    { scenario: lisbon, ago: day + 60 * minute },
    { scenario: regex, ago: 5 * minute },
  ]);

/** Open `path` and wait for a panel's first row. */
async function open(app: ReturnType<typeof harness>, path: string, panel: "Chats" | "Threads") {
  history.replace(path);
  await app.open(path);
  const nav = await screen.findByRole("navigation", { name: panel });
  await waitFor(() => expect(nav.querySelector("[data-row-focus]")).not.toBeNull());
}

test("the Chats place lists unsettled chats under Active, settled ones by day, and no project threads", async () => {
  const app = everyDay();
  await app.client.start();
  for (const chat of [espresso, tls, lisbon])
    await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(chat.thread.id) });
  await open(app, "/chats", "Chats");
  await waitFor(() =>
    expect(reading(chatsNav())).toEqual([
      "[Active]",
      "Regex for semver",
      "[Yesterday]",
      "Three days in Lisbon",
      "[Previous 7 days]",
      "How TLS 1.3 handshakes work",
      "[Earlier]",
      "Dialing in espresso",
    ]),
  );
  expect(within(chatsNav()).queryByRole("link", { name: /^Dedupe thread events/ })).toBeNull();
});

test("the Threads panel and History leave chats out", async () => {
  const app = everyDay();
  await app.client.start();
  await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(tls.thread.id) });
  await open(app, "/new", "Threads");
  expect(within(threadsNav()).getByRole("link", { name: /^Dedupe thread events/ })).toBeTruthy();
  for (const title of [/^Regex for semver/, /^Three days in Lisbon/, /^How TLS/])
    expect(within(threadsNav()).queryByRole("link", { name: title })).toBeNull();
  await userEvent.click(screen.getByRole("link", { name: /^History/ }));
  const main = screen.getByRole("main");
  await within(main).findByRole("heading", { level: 2, name: "History" });
  expect(within(main).queryByRole("link", { name: /^How TLS/ })).toBeNull();
});

test("New chat starts a chat at once, without asking for a project", async () => {
  const app = everyDay();
  await open(app, "/chats", "Chats");
  await userEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Project: none" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(location().search).toBe("?project=chat");
  // Still the Chats place, with its panel.
  expect(within(rail()).getByRole("link", { name: "Chats" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(chatsNav()).toBeTruthy();
});

test("Search chats narrows by title, and Escape brings every chat back", async () => {
  await open(everyDay(), "/chats", "Chats");
  const search = screen.getByRole("searchbox", { name: "Search chats" });
  await userEvent.type(search, "lisb");
  await waitFor(() => expect(reading(chatsNav())).toEqual(["[Active]", "Three days in Lisbon"]));
  await userEvent.keyboard("{Escape}");
  expect(search).toHaveProperty("value", "");
  await waitFor(() => expect(reading(chatsNav())).toContain("Dialing in espresso"));
});

test("Search chats finds an older chat the list hasn't loaded", async () => {
  // 25 settled project threads, newer than the chat, fill the list's first page.
  let at = now - 90 * day;
  const app = appAt(() => (at += 1));
  await app.client.start();
  app.play(espresso).runUntilBlocked();
  await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(espresso.thread.id) });
  const done = workbench().find((each) => each.thread.id === "thread-bump-codex");
  if (!done) throw new Error("Missing the finished scenario");
  at = now - 10 * day;
  for (let i = 0; i < 25; i++) {
    const id = `settled-${i}`;
    app.play({ ...done, thread: { ...done.thread, id, title: `Settled ${i}` } }).runUntilBlocked();
    await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(id) });
  }
  app.play(regex).runUntilBlocked();
  // Older pages never arrive, so only the search can find it.
  const paging = vi.spyOn(app.client, "threadsMore").mockReturnValue(new Promise(() => {}));
  try {
    await open(app, "/chats", "Chats");
    expect(within(chatsNav()).queryByRole("link", { name: /^Dialing in espresso/ })).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search chats" }), "espresso");
    await waitFor(() => expect(reading(chatsNav())).toEqual(["[Earlier]", "Dialing in espresso"]));
    await userEvent.click(within(chatsNav()).getByRole("link", { name: /^Dialing in espresso/ }));
    await waitFor(() => expect(location().pathname).toBe(`/t/${espresso.thread.id}`));
  } finally {
    paging.mockRestore();
  }
});

test("a chat that needs the person leads Chats' Active, and the title row has no Inbox", async () => {
  await open(
    chatsApp([
      { scenario: regex, ago: minute },
      { scenario: askingChat(), ago: day },
    ]),
    "/chats",
    "Chats",
  );
  await waitFor(() =>
    expect(reading(chatsNav()).slice(0, 3)).toEqual([
      "[Active]",
      "Clean up my downloads folder",
      "Regex for semver",
    ]),
  );
  expect(screen.queryByRole("button", { name: /^Inbox/ })).toBeNull();
  expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
});

test("the rail highlights Chats while a chat is open and Threads while a project thread is", async () => {
  const app = everyDay();
  await open(app, `/t/${lisbon.thread.id}`, "Chats");
  expect(place("Chats").getAttribute("aria-current")).toBe("page");
  expect(place("Threads").getAttribute("aria-current")).toBeNull();
  await visit("/t/thread-dedupe");
  await screen.findByRole("navigation", { name: "Threads" });
  expect(place("Threads").getAttribute("aria-current")).toBe("page");
  expect(place("Chats").getAttribute("aria-current")).toBeNull();
});

test("Move to project takes a chat out of Chats and into its project in Threads", async () => {
  const app = everyDay();
  await open(app, "/chats", "Chats");
  await userEvent.click(
    within(chatsNav()).getByRole("button", { name: "Move to project Three days in Lisbon" }),
  );
  const search = await screen.findByRole("combobox", { name: "Search projects" });
  await userEvent.type(search, "rel");
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(within(chatsNav()).queryByRole("link", { name: /^Three days in Lisbon/ })).toBeNull(),
  );
  await visit("/new");
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  expect(await within(threads).findByRole("link", { name: /^Three days in Lisbon/ })).toBeTruthy();
});
