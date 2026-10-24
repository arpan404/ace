import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

/** This Mac with a weather project, and maybe a build server with an api project. */
function world(others: readonly { hostId: string; name: string }[]) {
  const made = harness({ machines: others });
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/weather", git: true }]);
  made.daemon.projects.command({ type: "workspace.add", path: "/Users/dev/code/weather" });
  const build = made.machines.get("build");
  build?.projects.seedFolders("/home/ci", [{ path: "/home/ci/services/api", git: true }]);
  build?.projects.command({ type: "workspace.add", path: "/home/ci/services/api" });
  return { made, build };
}

const paths = (daemon: { projects: { list(): { workspaces: { path: string }[] } } }) =>
  daemon.projects.list().workspaces.map((project) => project.path);

async function openStep(made: ReturnType<typeof harness>) {
  await made.open("/");
  await userEvent.click(await screen.findByRole("link", { name: "New thread" }));
  return screen.findByRole("dialog", { name: "New thread in" });
}

const projectNames = async (step: HTMLElement) => {
  const list = await within(step).findByRole("listbox", { name: "Projects" });
  return within(list)
    .getAllByRole("option")
    .map((option) => option.textContent);
};

test("New thread in lists another machine's projects by keyboard and opens New thread there", async () => {
  const { made } = world([{ hostId: "build", name: "Build server" }]);
  const step = await openStep(made);
  await waitFor(async () => expect(await projectNames(step)).toEqual(["weather"]));

  // Tab reaches the machine chip; Enter lists the machines, arrows and Enter choose one.
  await userEvent.tab();
  expect(document.activeElement).toBe(
    within(step).getByRole("button", { name: "Machine: This Mac" }),
  );
  await userEvent.keyboard("{Enter}");
  await within(step).findByRole("listbox", { name: "Machines" });
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await waitFor(async () => expect(await projectNames(step)).toEqual(["api"]));
  expect(within(step).getByRole("button", { name: "Machine: Build server" })).toBeTruthy();

  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Project: api" })).toBeTruthy();
});

test("Backspace in the machine list returns to the projects of the machine already chosen", async () => {
  const { made } = world([{ hostId: "build", name: "Build server" }]);
  const step = await openStep(made);
  await userEvent.click(await within(step).findByRole("button", { name: "Machine: This Mac" }));
  await within(step).findByRole("listbox", { name: "Machines" });
  await userEvent.keyboard("{Backspace}");
  await waitFor(async () => expect(await projectNames(step)).toEqual(["weather"]));
});

test("a machine that isn't connected shows its status in New thread in and can't be chosen", async () => {
  const { made } = world([
    { hostId: "build", name: "Build server" },
    { hostId: "studio", name: "Studio" },
  ]);
  const step = await openStep(made);
  made.crashMachine("studio");
  await userEvent.click(await within(step).findByRole("button", { name: "Machine: This Mac" }));
  const studio = await within(step).findByRole("option", { name: "Studio, Offline" });
  expect(studio.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(studio);
  expect(within(step).getByRole("listbox", { name: "Machines" })).toBeTruthy();
});

test("with one machine New thread in lists its projects and names no machine", async () => {
  const { made } = world([]);
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/relay", git: true }]);
  made.daemon.projects.command({ type: "workspace.add", path: "/Users/dev/code/relay" });
  const step = await openStep(made);
  await waitFor(async () => expect(await projectNames(step)).toEqual(["relay", "weather"]));
  expect(within(step).queryByRole("button", { name: /^Machine:/ })).toBeNull();
});

test("a folder created from the project picker on Build server is made there and stays chosen", async () => {
  const { made, build } = world([{ hostId: "build", name: "Build server" }]);
  if (!build) throw new Error("no build server");
  await made.open("/new?machine=build");
  await userEvent.click(await screen.findByRole("button", { name: "Project: api" }));
  await userEvent.type(await screen.findByRole("combobox", { name: "Search projects" }), "jobs");
  await userEvent.click(await screen.findByRole("option", { name: "Create jobs and add" }));

  expect(await screen.findByRole("button", { name: "Project: jobs" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(paths(build)).toContain("/home/ci/services/jobs");
  expect(paths(made.daemon)).toEqual(["/Users/dev/code/weather"]);
});
