import { flakyCheckout } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fakeOrgHostId } from "@/boot/fake-orgs.ts";
import { harness } from "@/test/harness.tsx";
import { orgBackend } from "@/test/org-backend.ts";
import { openSearchSheet } from "@/test/open-search.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const personalThread = "Tune the weather cache";
const orgThread = "Add rate limits to the api";

/**
 * This Mac, the person's own machine, with its weather project and a thread there; and the build
 * server, Acme Robotics' host (ADR 0206 §2.4), with its api project and a thread there.
 */
function world(options: { space?: string } = {}) {
  const account = orgBackend(options);
  const made = harness({
    account: account.backend,
    machines: [{ hostId: fakeOrgHostId, name: "Build server" }],
  });
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/weather", git: true }]);
  made.daemon.projects.command({ type: "workspace.add", path: "/Users/dev/code/weather" });
  const weather = made.daemon.projects.list().workspaces[0];
  const build = made.machines.get(fakeOrgHostId);
  if (!weather || !build) throw new Error("no machines");
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/services/api", git: true }]);
  build.projects.command({ type: "workspace.add", path: "/home/ci/services/api" });
  const api = build.projects.list().workspaces[0];
  if (!api) throw new Error("no api project");
  made.daemon.createThread({
    id: "thread-weather",
    provider: "claude",
    hasSentMessage: true,
    workspaceId: weather.id,
    title: personalThread,
  });
  build.createThread({
    id: "thread-api",
    provider: "claude",
    hasSentMessage: true,
    workspaceId: api.id,
    title: orgThread,
    details: { workspace: api },
  });
  return { made, account };
}

const sidebar = () => screen.findByRole("navigation", { name: "Projects" });
const sidebarText = async () => (await sidebar()).textContent ?? "";

/** The rail's account mark: the window's space is picked from its menu. */
async function switchTo(space: RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: /, account/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: space }));
}

/** The project filter's projects, as its menu lists them. */
async function filterProjects() {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter/ }));
  const menu = await screen.findByRole("menu");
  const names = within(menu)
    .queryAllByRole("menuitemradio")
    .map((item) => item.getAttribute("aria-label") ?? item.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  return names;
}

test("switching to an organization never shows a personal thread or project, even while its hosts load", async () => {
  const { made, account } = world();
  // Acme's hosts are held from the start, so the switch lands before the space can place them.
  const release = account.hold((call) => call.includes(`/v1/orgs/${account.orgs.acme}/hosts`));
  await made.open("/new");
  await waitFor(async () => expect(await sidebarText()).toContain(personalThread));

  await switchTo(/Acme Robotics/);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Acme Robotics, account/ })).toBeDefined(),
  );
  // Mid-load: nothing of Personal's is drawn, and no claim that Acme has no projects.
  expect(screen.queryByText(personalThread)).toBeNull();
  expect(screen.queryByText(/No projects in Acme Robotics/)).toBeNull();

  release();
  await waitFor(async () => expect(await sidebarText()).toContain(orgThread));
  expect(screen.queryByText(personalThread)).toBeNull();
  const projects = await filterProjects();
  expect(projects.some((name) => name.includes("api"))).toBe(true);
  expect(projects.some((name) => name.includes("weather"))).toBe(false);
});

test("Personal never shows an organization host's project or thread", async () => {
  const { made } = world();
  await made.open("/new");
  await waitFor(async () => expect(await sidebarText()).toContain(personalThread));
  // The build server is online with its api thread: Acme shows it, and back in Personal it's gone.
  await switchTo(/Acme Robotics/);
  await waitFor(async () => expect(await sidebarText()).toContain(orgThread));
  await switchTo(/^Personal/);
  await waitFor(async () => expect(await sidebarText()).toContain(personalThread));
  expect(await sidebarText()).not.toContain(orgThread);
  const projects = await filterProjects();
  expect(projects.some((name) => name.includes("weather"))).toBe(true);
  expect(projects.some((name) => name.includes("api"))).toBe(false);
});

test("an organization with no projects says so plainly", async () => {
  const { made, account } = world({ space: "org_01NIGHTSHIFT" });
  await made.open("/new");
  expect(await screen.findByText("No projects in Night Shift Labs yet")).toBeDefined();
  expect(screen.queryByText(personalThread)).toBeNull();
  expect(screen.queryByText(orgThread)).toBeNull();
  expect(account.calls.some(({ call }) => call.startsWith("DELETE"))).toBe(false);
});

test("a notice from another space is labelled with it and opens the thread in that space", async () => {
  const { made, account } = world({ space: orgBackend().orgs.acme });
  const checkout = made.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await made.open("/new");
  await waitFor(async () => expect(await sidebarText()).toContain(orgThread));
  expect(screen.queryByText("Fix flaky checkout test")).toBeNull();

  checkout.runThrough("approval-requested");
  const toasts = await screen.findByRole("region", { name: "Notifications" });
  expect(
    await within(toasts).findByText("Personal · billing-api · Fix flaky checkout test"),
  ).toBeDefined();
  await userEvent.click(within(toasts).getByRole("button", { name: "Review" }));

  await screen.findByRole("heading", { level: 1, name: "Fix flaky checkout test" });
  // The window now shows Personal: its own threads, never Acme's.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Acme Robotics, account/ })).toBeNull(),
  );
  await waitFor(async () => expect(await sidebarText()).toContain(personalThread));
  expect(await sidebarText()).not.toContain(orgThread);
  expect(account.calls.some(({ call }) => call.startsWith("DELETE"))).toBe(false);
});

test("search finds only the threads of the window's space", async () => {
  const { made } = world({ space: orgBackend().orgs.acme });
  await made.open("/new");
  await waitFor(async () => expect(await sidebarText()).toContain(orgThread));
  const field = await openSearchSheet();
  await userEvent.type(field, "retry budget");
  // This Mac's threads are Personal's: in Acme the search finds none of them.
  await screen.findByText("No matches");
  expect(screen.queryByText(/Retry budget for app-server restarts/)).toBeNull();
  await userEvent.keyboard("{Escape}");

  await switchTo(/^Personal/);
  const again = await openSearchSheet();
  await userEvent.type(again, "retry budget");
  const results = await screen.findByRole("listbox", { name: "Results" });
  expect(within(results).getAllByRole("option").length).toBeGreaterThan(0);
});
