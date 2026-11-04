import {
  askingChatScenario,
  chatScenario,
  ScenarioPlayer,
  workbench,
  type Scenario,
} from "@ace/fake-daemon";
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const chatsNav = () => screen.getByRole("navigation", { name: "Chats" });
const rail = () => screen.getByRole("navigation", { name: "App" });
const titles = (nav: HTMLElement) =>
  [...nav.querySelectorAll<HTMLElement>("[data-row-focus]")].map(
    (row) => row.getAttribute("aria-label")?.split(". ")[0],
  );

const lisbon = chatScenario("trip", "Three days in Lisbon", "claude", "Plan Lisbon.", "Alfama.");
const cron = chatScenario("cron", "Cron for weekdays at 6", "codex", "Cron?", "0 6 * * 1-5");

/** This Mac with a chat and the workbench's projects, and a build server with a chat of its own. */
function twoMachines(path: string, buildChat: Scenario | null = cron) {
  const history: RouterHistory = createMemoryHistory({ initialEntries: [path] });
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }], history });
  const build = app.machines.get("build");
  if (!build) throw new Error("no build server");
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.play(lisbon).runUntilBlocked();
  if (buildChat) new ScenarioPlayer(build, buildChat).runUntilBlocked();
  return { app, build, history };
}

async function openChats(app: ReturnType<typeof harness>, path = "/chats") {
  await app.open(path);
  await waitFor(() => expect(titles(chatsNav())).toContain("Cron for weekdays at 6"));
}

async function chooseDevice(name: string) {
  await userEvent.click(screen.getByRole("button", { name: /^Chats, Device:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}

test("chats from another machine join the list and name their machine", async () => {
  const { app } = twoMachines("/chats");
  await openChats(app);
  expect(titles(chatsNav())).toContain("Three days in Lisbon");
  const row = within(chatsNav()).getByRole("link", { name: /^Cron for weekdays at 6/ });
  // As in Threads: the machine is in the row's spoken name, not drawn on the line.
  expect(row.getAttribute("aria-label")).toContain("Running on Build server");
  expect(row.getAttribute("href")).toContain("machine=build");
});

test("the Chats device filter narrows the list and the search, apart from Threads' filter", async () => {
  const { app } = twoMachines("/chats");
  await openChats(app);
  await chooseDevice("Build server");
  await waitFor(() => expect(titles(chatsNav())).toEqual(["Cron for weekdays at 6"]));
  const search = screen.getByRole("searchbox", { name: "Search chats" });
  await userEvent.type(search, "lisbon");
  expect(await within(chatsNav()).findByText("No chats match.")).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.type(search, "cron");
  await waitFor(() => expect(titles(chatsNav())).toEqual(["Cron for weekdays at 6"]));
  // This Mac's own chats only, then all of them again.
  await userEvent.clear(search);
  await chooseDevice("This Mac");
  await waitFor(() => expect(titles(chatsNav())).toEqual(["Three days in Lisbon"]));
  await chooseDevice("All devices");
  await waitFor(() => expect(titles(chatsNav())).toHaveLength(2));
  // Threads keeps its own filter: it never narrowed.
  await userEvent.click(within(rail()).getByRole("link", { name: /^Threads/ }));
  const filter = await screen.findByRole("button", { name: /^Project filter:/ });
  expect(filter.getAttribute("aria-label")).toBe("Project filter: All projects");
});

test("a device with no chats says so and offers every device back", async () => {
  const { app } = twoMachines("/chats", null);
  await app.open("/chats");
  await waitFor(() => expect(titles(chatsNav())).toEqual(["Three days in Lisbon"]));
  await chooseDevice("Build server");
  expect(await within(chatsNav()).findByText("No chats on Build server")).toBeTruthy();
  await userEvent.click(within(chatsNav()).getByRole("button", { name: "Show all devices" }));
  await waitFor(() => expect(titles(chatsNav())).toEqual(["Three days in Lisbon"]));
});

test("New chat with a device chosen starts on that device and makes its chat project there", async () => {
  const { app, build, history } = twoMachines("/chats");
  await openChats(app);
  await chooseDevice("Build server");
  await userEvent.click(screen.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(history.location.pathname).toBe("/new"));
  expect(history.location.search).toContain("machine=build");
  expect(history.location.search).toContain("project=chat");
  // The page's own machine line names the device, and lets the person move it.
  expect(await screen.findByRole("button", { name: "Computer: Build server" })).toBeTruthy();
  const chatProjects = () => build.projects.list().workspaces.filter((p) => p.kind === "chat");
  await waitFor(() => expect(chatProjects().length).toBe(2));
  expect(app.daemon.projects.list().workspaces.filter((p) => p.kind === "chat")).toHaveLength(1);
});

test("another machine's chat that needs the person is in Chats' Active and lights the Chats dot", async () => {
  const asks = askingChatScenario("disk", "Why is the disk full?", "Disk?", "du -sh /var");
  const { app } = twoMachines("/new", asks);
  await app.open("/new");
  await screen.findByRole("navigation", { name: "Threads" });
  await waitFor(() =>
    expect(
      within(rail())
        .getByRole("link", { name: /^Chats/ })
        .getAttribute("aria-label"),
    ).toBe("Chats, 1 needs you"),
  );
  await userEvent.click(within(rail()).getByRole("link", { name: /^Chats/ }));
  const chats = await screen.findByRole("navigation", { name: "Chats" });
  const row = await within(chats).findByRole("link", { name: /^Why is the disk full\?/ });
  expect(row.getAttribute("aria-label")).toContain("Build server");
});

test("the top bar shows a chat bubble, not a project folder, while a chat is open", async () => {
  const { app } = twoMachines("/t/thread-chat-trip");
  await app.open("/t/thread-chat-trip");
  const banner = within(await screen.findByRole("banner"));
  expect(await banner.findByRole("img", { name: "Chat" })).toBeTruthy();
  expect(banner.queryByRole("img", { name: /^Project/ })).toBeNull();
});
