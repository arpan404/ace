import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  filterProjects,
  orgThread,
  personalThread,
  sidebarText,
  switchTo,
  world,
} from "@/test/space-world.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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
