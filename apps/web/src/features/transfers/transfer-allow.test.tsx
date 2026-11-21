import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { continueOn, linkedMachines } from "./transfer-fixture.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** The laptop's record of this Mac's link: the device Allow projects changes there. */
const linkOnLaptop = (fixture: ReturnType<typeof linkedMachines>) =>
  fixture.machine("laptop").access.get("fleet-this-mac-on-laptop");

test("a machine that doesn't allow projects says so, allows them from here, and takes the thread", async () => {
  const fixture = linkedMachines();
  const { app, finish } = fixture;
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Old laptop" }));

  expect(
    await within(dialog).findByText("Old laptop doesn't take projects from This Mac yet."),
  ).toBeTruthy();
  const allow = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: "Allow projects on Old laptop",
  });
  await waitFor(() => expect(allow.disabled).toBe(false));
  await userEvent.click(allow);

  // The laptop's own record of this Mac's link now holds Projects; nothing paired again.
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Continue on Old laptop" }),
  );
  expect(linkOnLaptop(fixture)?.scopes).toContain("projects");
  await finish();
  expect(await within(dialog).findByText("Continued on Old laptop")).toBeTruthy();
  expect(
    fixture
      .machine("laptop")
      .projects.list()
      .workspaces.map((each) => each.name),
  ).toEqual(["weather"]);
}, 30_000);

test("a window that can't manage that machine is sent to its Fleet page instead", async () => {
  const fixture = linkedMachines();
  const { app } = fixture;
  fixture.machine("laptop").refuseRequests("forbidden", "fleet.request");
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Old laptop" }));

  expect(
    await within(dialog).findByText(
      "Old laptop doesn't take projects from This Mac yet; allow them on Old laptop in Settings › Fleet.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: /^Allow projects/ })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Open Settings › Fleet" }));
  expect(await screen.findByRole("heading", { name: "Old laptop", level: 2 })).toBeTruthy();
  expect(linkOnLaptop(fixture)?.scopes).not.toContain("projects");
}, 30_000);

test("a link that may only view there isn't offered Projects, since it still couldn't take work", async () => {
  const fixture = linkedMachines();
  const { app } = fixture;
  app.daemon.linkTo(fixture.machine("laptop"), { access: "read", projects: false });
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Old laptop" }));

  expect(
    await within(dialog).findByText(
      "This Mac's link can only view on Old laptop, so it can't take projects; unlink and link them again in Settings › Fleet.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: /^Allow projects/ })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Open Settings › Fleet" })).toBeTruthy();
  expect(linkOnLaptop(fixture)?.scopes).toEqual(["read"]);
}, 30_000);

test("a machine whose ace can't change a link in place says to update it or link again", async () => {
  const fixture = linkedMachines();
  const { app } = fixture;
  fixture.machine("laptop").services.fleet.unknownOps.add("scope");
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Old laptop" }));
  const allow = await within(dialog).findByRole<HTMLButtonElement>("button", {
    name: "Allow projects on Old laptop",
  });
  await waitFor(() => expect(allow.disabled).toBe(false));
  await userEvent.click(allow);

  expect(
    await within(dialog).findByText(
      "Old laptop runs an older ace that can't allow projects from here. Update ace there, or unlink and link them again in Settings › Fleet.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: /^Allow projects/ })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Open Settings › Fleet" })).toBeTruthy();
}, 30_000);

test("from another machine's thread, Allow projects widens that machine's link, never this window's", async () => {
  const history = createMemoryHistory({ initialEntries: ["/t/thread-forecast"] });
  const fixture = linkedMachines({ history });
  const { app, build } = fixture;
  const laptop = fixture.machine("laptop");
  // The build server links to this Mac and to the laptop, without Projects there either.
  build.linkTo(app.daemon);
  build.linkTo(laptop, { projects: false });
  build.createThread({
    id: "thread-deploy",
    workspaceId: "deploy",
    title: "Tune the deploy script",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace: { id: "deploy", name: "deploy", path: "/srv/deploy" } },
  });
  // This Mac's own links are read first, from its own thread.
  await app.open("/t/thread-forecast");
  let dialog = await continueOn();
  expect(await within(dialog).findByRole("option", { name: "Old laptop" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Then from the build server's thread: its links are listed, and its own link is allowed.
  await act(async () => history.push("/t/thread-deploy?machine=build"));
  await screen.findByRole("heading", { name: "Tune the deploy script" });
  dialog = await continueOn();
  const machines = await within(dialog).findByRole("listbox", { name: "Machines" });
  await waitFor(() =>
    expect(
      within(machines)
        .getAllByRole("option")
        .map((each) => each.textContent),
    ).toEqual(["This Mac", "Old laptopProjects not allowed"]),
  );
  await userEvent.click(within(machines).getByRole("option", { name: /Old laptop/ }));
  expect(
    await within(dialog).findByText("Old laptop doesn't take projects from Build server yet."),
  ).toBeTruthy();
  const allow = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: "Allow projects on Old laptop",
  });
  await waitFor(() => expect(allow.disabled).toBe(false));
  await userEvent.click(allow);
  await within(dialog).findByRole("button", { name: "Continue on Old laptop" });
  expect(laptop.access.get("fleet-build-on-laptop")?.scopes).toContain("projects");
  expect(linkOnLaptop(fixture)?.scopes).not.toContain("projects");
}, 30_000);

test("Projects allowed after the person went back to another machine leave that machine's step", async () => {
  const fixture = linkedMachines();
  const { app } = fixture;
  const laptop = fixture.machine("laptop");
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Old laptop" }));
  const allow = await within(dialog).findByRole<HTMLButtonElement>("button", {
    name: "Allow projects on Old laptop",
  });
  await waitFor(() => expect(allow.disabled).toBe(false));

  // The laptop answers slowly; meanwhile the person goes back and picks the build server.
  const answer = laptop.deferRequests("fleet.request");
  await userEvent.click(allow);
  await userEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  expect(
    await within(dialog).findByRole("button", { name: "Continue on Build server" }),
  ).toBeTruthy();

  await act(async () => answer());
  await waitFor(() => expect(linkOnLaptop(fixture)?.scopes).toContain("projects"));
  // The reads the late answer refreshes settle before the step would change.
  await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  expect(within(dialog).getByRole("button", { name: "Continue on Build server" })).toBeTruthy();
  expect(within(dialog).queryAllByText(/Old laptop/)).toEqual([]);
}, 30_000);
