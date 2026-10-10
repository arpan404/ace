import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** This Mac and a build server, each with folders of its own. */
function twoMachines(options: Parameters<typeof harness>[0] = {}) {
  const made = harness({ ...options, machines: [{ hostId: "build", name: "Build server" }] });
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/weather", git: true }]);
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  build.projects.seedFolders("/home/ci", [
    { path: "/home/ci/services/api", git: true },
    { path: "/home/ci/services/worker", git: true },
  ]);
  return { made, build };
}
const paths = (daemon: { projects: { list(): { workspaces: { path: string }[] } } }) =>
  daemon.projects.list().workspaces.map((project) => project.path);
const picker = () => screen.findByRole("radiogroup", { name: "Machine" });
const checked = async () =>
  within(await picker())
    .getAllByRole("radio")
    .find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.getAttribute("aria-label");
const folders = () => screen.findByRole("listbox", { name: "Folders" });
const option = async (name: string) =>
  within(await folders()).findByRole("option", { name: new RegExp(`^${name}`) });

async function addProject(made: ReturnType<typeof harness>) {
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await screen.findByRole("dialog", { name: "Add project" });
  await userEvent.click(screen.getByRole("option", { name: "Local folder" }));
}

test("with two machines the picker lists both with their status, and ⌘M cycles them", async () => {
  const { made } = twoMachines();
  await addProject(made);
  const radios = within(await picker()).getAllByRole("radio");
  await waitFor(() =>
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "This Mac, connected",
      "Build server, connected",
    ]),
  );
  expect(await checked()).toBe("This Mac, connected");
  await userEvent.keyboard("{Control>}m{/Control}");
  expect(await checked()).toBe("Build server, connected");
  // The folders below follow the chosen machine.
  expect(await option("services")).toBeTruthy();
  await userEvent.keyboard("{Control>}m{/Control}");
  expect(await checked()).toBe("This Mac, connected");
  expect(await option("code")).toBeTruthy();
});

test("the picker is reachable with the keyboard and arrows choose a machine", async () => {
  const { made } = twoMachines();
  await addProject(made);
  await waitFor(async () => expect(within(await picker()).getAllByRole("radio")).toHaveLength(2));
  // Tab backwards through the dialog until its chosen machine is reached.
  const selected = within(await picker()).getByRole("radio", { checked: true });
  for (let press = 0; press < 12 && document.activeElement !== selected; press++)
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(selected);
  await userEvent.keyboard("{ArrowRight}");
  expect(await checked()).toBe("Build server, connected");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Build server, connected");
});

test("a folder opened on the build server is added there, not on this machine", async () => {
  const { made, build } = twoMachines();
  await addProject(made);
  await userEvent.keyboard("{Control>}m{/Control}");
  const search = await screen.findByRole("combobox", { name: "Search folders" });
  await userEvent.type(search, "api");
  await option("api");
  await userEvent.keyboard("{Enter}");

  expect(await screen.findByText("Added api on Build server")).toBeTruthy();
  expect(paths(build)).toEqual(["/home/ci/services/api"]);
  expect(paths(made.daemon)).toEqual([]);
});

test("recent projects from every machine show together, each marked with its machine", async () => {
  const { made, build } = twoMachines();
  await addProject(made);
  // Registered elsewhere meanwhile, as another device would.
  build.projects.command({ type: "workspace.add", path: "/home/ci/services/worker" });
  made.daemon.projects.command({ type: "workspace.add", path: "/Users/dev/code/weather" });
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const recent = await within(await folders()).findByRole("group", { name: "Recent" });
  await waitFor(() => {
    const rows = within(recent)
      .getAllByRole("option")
      .map((row) => row.textContent ?? "");
    expect(rows.some((row) => /^weather.*Project.*This Mac$/.test(row))).toBe(true);
    expect(rows.some((row) => /^worker.*Project.*Build server$/.test(row))).toBe(true);
  });

  // Opening the build server's project from here registers nothing on this machine.
  await userEvent.type(screen.getByRole("combobox", { name: "Search folders" }), "work");
  const projects = await within(await folders()).findByRole("group", {
    name: "Projects on your machines",
  });
  await userEvent.click(within(projects).getByRole("option", { name: /^worker/ }));
  expect(await screen.findByText("Added worker on Build server")).toBeTruthy();
  expect(paths(made.daemon)).toEqual(["/Users/dev/code/weather"]);
});

test("a new project is created on the chosen machine", async () => {
  const { made, build } = twoMachines();
  await addProject(made);
  await userEvent.keyboard("{Control>}2{/Control}{Control>}m{/Control}");
  expect(await checked()).toBe("Build server, connected");
  await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "jobs");
  expect(await screen.findByText("Creates ~/jobs")).toBeTruthy();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(await screen.findByText("Created jobs on Build server")).toBeTruthy();
  expect(paths(build)).toEqual(["/home/ci/jobs"]);
  expect(paths(made.daemon)).toEqual([]);
});

test("a clone runs on the chosen machine with its progress, and Cancel stops it there", async () => {
  // Clones advance one Git stage each time the test says so.
  const stages: (() => void)[] = [];
  const { made, build } = twoMachines({
    projectScheduler: (callback) => void stages.push(callback),
  });
  await addProject(made);
  await userEvent.keyboard("{Control>}3{/Control}{Control>}m{/Control}");
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Repository address" }),
    "acme/big-repo",
  );
  await screen.findByText("Clones into ~/big-repo");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  const bar = await screen.findByRole("progressbar", { name: "Clone progress" });
  expect(
    screen.getByText(
      (text, element) =>
        text.includes("· on") && element?.textContent?.includes("Build server") === true,
    ),
  ).toBeTruthy();
  await waitFor(() => expect(stages.length).toBeGreaterThan(0));
  stages.shift()?.();
  await waitFor(() => expect(bar.getAttribute("aria-valuetext")).toBe("Receiving objects, 24%"));

  await userEvent.click(screen.getByRole("button", { name: "Cancel clone" }));
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  expect(paths(build)).toEqual([]);
  expect(paths(made.daemon)).toEqual([]);
});

test("a machine that goes away says so and offers nothing to open on it", async () => {
  const { made, build } = twoMachines();
  await addProject(made);
  await userEvent.keyboard("{Control>}m{/Control}");
  await option("services");
  build.refuseConnections(true);
  expect(
    await screen.findByText(
      "Build server isn't connected. Folders and actions come back once it is.",
    ),
  ).toBeTruthy();
  expect(await checked()).toMatch(/^Build server, (connecting|offline)$/);
  expect(screen.getByRole("button", { name: "Select a folder" }).hasAttribute("disabled")).toBe(
    true,
  );
});

test("a chosen machine that leaves the pool stays chosen, so nothing lands on another", async () => {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  // The same absolute path exists on both machines.
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/srv/app" }], {
    roots: ["/Users/dev", "/srv"],
  });
  made.machines.get("build")?.projects.seedFolders("/home/ci", [{ path: "/srv/app" }], {
    roots: ["/home/ci", "/srv"],
  });
  await addProject(made);
  await userEvent.keyboard("{Control>}m{/Control}");
  expect(await checked()).toBe("Build server, connected");
  const search = await screen.findByRole("combobox", { name: "Search folders" });
  await userEvent.type(search, "/srv/app/");
  await option("app");

  await made.pool().remove("build");
  expect(
    await screen.findByText(
      "Build server was removed from your machines. Choose a machine to carry on.",
    ),
  ).toBeTruthy();
  // No machine is chosen in its place, and the typed folder can't be opened anywhere.
  expect(await checked()).toBeUndefined();
  await userEvent.click(search);
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Select a folder" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(paths(made.daemon)).toEqual([]);

  // Choosing this machine is explicit, and then it works here.
  await userEvent.click(within(await picker()).getByRole("radio", { name: /^This Mac/ }));
  await option("app");
  await userEvent.click(search);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(paths(made.daemon)).toEqual(["/srv/app"]));
});

test("a path completion that answers after switching machines is dropped", async () => {
  const { made, build } = twoMachines();
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/weather" }]);
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/cobalt/api" }]);
  await addProject(made);
  const search = await screen.findByRole("combobox", { name: "Search folders" });
  // This Mac is slow to complete ~/co.
  const release = made.daemon.projects.holdReads((operation) => operation.op === "fs.complete");
  await userEvent.type(search, "~/co");
  await userEvent.keyboard("{Tab}");
  await userEvent.keyboard("{Control>}m{/Control}");
  expect(await checked()).toBe("Build server, connected");
  release();
  // A round trip on This Mac's connection: its completion reply has arrived by now.
  await made.client.projects.home();
  expect(search).toHaveProperty("value", "~/co");

  // Build server completes from its own folders.
  await userEvent.click(search);
  await userEvent.keyboard("{Tab}");
  await waitFor(() => expect(search).toHaveProperty("value", "~/cobalt/"));
});

test("Retry after the machine's worker is replaced clones through the new connection", async () => {
  const stages: (() => void)[] = [];
  const { made, build } = twoMachines({
    projectScheduler: (callback) => void stages.push(callback),
  });
  await addProject(made);
  await userEvent.keyboard("{Control>}3{/Control}{Control>}m{/Control}");
  build.refuseCommands("git_failed", "workspace.clone");
  expect(screen.queryByRole("textbox", { name: "Icon URL" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Upload image" })).toBeNull();
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Repository address" }),
    "acme/web",
  );
  await screen.findByText("Clones into ~/web");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  expect(await screen.findByText(/Git couldn't finish/)).toBeTruthy();

  // The build server's worker dies and a fresh one connects.
  build.restoreRequests();
  made.crashMachine("build");
  await waitFor(async () => expect(await checked()).toMatch(/^Build server, (offline|connecting)/));
  made.pool().reconnect("build");
  await waitFor(async () => expect(await checked()).toBe("Build server, connected"));

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("progressbar", { name: "Clone progress" });
  for (let stage = 0; stage < 5; stage++) {
    await waitFor(() => expect(stages.length).toBeGreaterThan(0));
    stages.shift()?.();
  }
  expect(await screen.findByText("Cloned web on Build server")).toBeTruthy();
  expect(paths(build)).toEqual(["/home/ci/web"]);
  expect(build.projects.list().workspaces[0]?.icon).toBeUndefined();
  expect(paths(made.daemon)).toEqual([]);
});
