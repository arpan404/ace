import { act, screen, waitFor, within } from "@testing-library/react";
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
const folders = () => screen.findByRole("listbox", { name: "Folders" });
const option = async (name: string) => within(await folders()).findByRole("option", { name });

/** ⇧⌘O starts on this machine; Ctrl+M lists the machines to add the project on another. */
async function addProjectOn(made: ReturnType<typeof harness>, machine: string, source: string) {
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await screen.findByRole("listbox", { name: "Project sources" });
  await userEvent.keyboard("{Control>}m{/Control}");
  const machines = await screen.findByRole("listbox", { name: "Machines" });
  await userEvent.click(await within(machines).findByRole("option", { name: machine }));
  await userEvent.click(await screen.findByRole("option", { name: source }));
}

test("with two machines Add project starts on this machine, and the chip moves it to another", async () => {
  const { made } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  expect(await option("code")).toBeTruthy();

  // The chip names the machine in full and lists the machines.
  const chip = screen.getByRole("button", { name: "Machine: This Mac" });
  expect(chip.getAttribute("title")).toBe("This Mac");
  await userEvent.click(chip);
  const machines = await screen.findByRole("listbox", { name: "Machines" });
  await waitFor(() =>
    expect(
      within(machines)
        .getAllByRole("option")
        .map((each) => each.textContent),
    ).toEqual(["This Mac", "Build server"]),
  );
  await userEvent.click(within(machines).getByRole("option", { name: "Build server" }));
  expect(await option("services")).toBeTruthy();
});

test("machine search text does not filter the source list", async () => {
  const { made } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await screen.findByRole("listbox", { name: "Project sources" });
  await userEvent.keyboard("{Control>}m{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search machines" }), "build");
  await userEvent.keyboard("{Enter}");

  const field = await screen.findByRole("combobox", { name: "Search project sources" });
  expect(field).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(
    within(screen.getByRole("listbox", { name: "Project sources" }))
      .getAllByRole("option")
      .map((each) => each.textContent),
  ).toEqual(["Local folder", "New project", "Git URL", "GitHub repository"]);
});

test("Ctrl+M opens the machine picker from the local folder step and keeps what was typed", async () => {
  const { made } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const field = await screen.findByRole("combobox", { name: "Folder path" });
  await userEvent.clear(field);
  await userEvent.type(field, "~/code/");

  await userEvent.keyboard("{Control>}m{/Control}");
  const machines = await screen.findByRole("listbox", { name: "Machines" });
  // Choosing the same machine again returns to the folder as it was left, field focused.
  await userEvent.click(within(machines).getByRole("option", { name: "This Mac" }));
  const again = await screen.findByRole("combobox", { name: "Folder path" });
  expect(again).toHaveProperty("value", "~/code/");
  await waitFor(() => expect(document.activeElement).toBe(again));
});

/** Lists the machines from the chip and chooses one. */
async function pick(name: string) {
  await userEvent.click(screen.getByRole("button", { name: /^Machine:/ }));
  const machines = await screen.findByRole("listbox", { name: "Machines" });
  await userEvent.click(within(machines).getByRole("option", { name }));
}

test("a Git URL typed for one machine is still there after visiting another", async () => {
  const { made } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Git URL" }));
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Repository address" }),
    "acme/here",
  );

  await pick("Build server");
  // Another machine has a form of its own.
  expect(await screen.findByRole("textbox", { name: "Repository address" })).toHaveProperty(
    "value",
    "",
  );
  await pick("This Mac");
  expect(await screen.findByRole("textbox", { name: "Repository address" })).toHaveProperty(
    "value",
    "acme/here",
  );
});

test("a folder added on the build server is added there and opens New thread there", async () => {
  const { made, build } = twoMachines();
  await addProjectOn(made, "Build server", "Local folder");
  const field = await screen.findByRole("combobox", { name: "Folder path" });
  await userEvent.clear(field);
  await userEvent.type(field, "~/services/api/");
  await screen.findByText("~/services/api");
  await userEvent.keyboard("{Enter}");

  // New thread opens on the build server, in the project just added.
  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Project: api" })).toBeTruthy();
  expect(paths(build)).toEqual(["/home/ci/services/api"]);
  expect(paths(made.daemon)).toEqual([]);
});

test("adding a folder that is already a project on the build server opens a new thread there", async () => {
  const { made, build } = twoMachines();
  build.projects.command({ type: "workspace.add", path: "/home/ci/services/api" });
  await addProjectOn(made, "Build server", "Local folder");
  const field = await screen.findByRole("combobox", { name: "Folder path" });
  await userEvent.clear(field);
  await userEvent.type(field, "~/services/api/");
  await screen.findByText("~/services/api");
  await userEvent.keyboard("{Enter}");

  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Project: api" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull();
  expect(paths(build)).toEqual(["/home/ci/services/api"]);
});

test("a new project is created on the chosen machine and New thread opens there", async () => {
  const { made, build } = twoMachines();
  await addProjectOn(made, "Build server", "New project");
  await userEvent.type(await screen.findByRole("textbox", { name: "Project name" }), "jobs");
  expect(await screen.findByText("~/jobs")).toBeTruthy();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Project: jobs" })).toBeTruthy();
  expect(paths(build)).toEqual(["/home/ci/jobs"]);
  expect(paths(made.daemon)).toEqual([]);
});

test("a clone runs on the chosen machine with its progress, and Cancel stops it there", async () => {
  // Clones advance one Git stage each time the test says so.
  const stages: (() => void)[] = [];
  const { made, build } = twoMachines({
    projectScheduler: (callback) => void stages.push(callback),
  });
  await addProjectOn(made, "Build server", "Git URL");
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Repository address" }),
    "acme/big-repo",
  );
  await screen.findByText("~/big-repo");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  // One status line says what is cloning, on which machine, and how far it is.
  const status = await screen.findByText(
    (_, element) =>
      element?.getAttribute("role") === "status" &&
      element.textContent === "Cloning acme/big-repo on Build server…",
  );
  await waitFor(() => expect(stages.length).toBeGreaterThan(0));
  stages.shift()?.();
  await waitFor(() =>
    expect(status.textContent).toBe("Cloning acme/big-repo on Build server… 24%"),
  );

  await userEvent.click(screen.getByRole("button", { name: "Cancel clone" }));
  await waitFor(() => expect(screen.queryByText(/Cloning acme\/big-repo/)).toBeNull());
  expect(paths(build)).toEqual([]);
  expect(paths(made.daemon)).toEqual([]);
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
  await addProjectOn(made, "Build server", "Local folder");
  const field = await screen.findByRole("combobox", { name: "Folder path" });
  await userEvent.clear(field);
  await userEvent.type(field, "/srv/app/");
  await screen.findByText("/srv/app");

  await made.pool().remove("build");
  expect(
    await screen.findByText("Build server isn't connected. Folders come back once it is."),
  ).toBeTruthy();
  // Nothing takes its place: the typed folder can't be added anywhere.
  await userEvent.click(field);
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  expect(paths(made.daemon)).toEqual([]);

  // Choosing this machine is explicit, and then it works here.
  await userEvent.click(screen.getByRole("button", { name: "Machine: Build server" }));
  await userEvent.click(
    within(await screen.findByRole("listbox", { name: "Machines" })).getByRole("option", {
      name: "This Mac",
    }),
  );
  const here = await screen.findByRole("combobox", { name: "Folder path" });
  await userEvent.clear(here);
  await userEvent.type(here, "/srv/app/");
  // The build server's step keeps its draft, hidden: wait on this machine's own Add.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(false),
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(paths(made.daemon)).toEqual(["/srv/app"]));
});

test("with the other machine offline Add project doesn't ask which machine", async () => {
  const { made } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  made.crashMachine("build");
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  expect(await screen.findByRole("option", { name: "Local folder" })).toBeTruthy();
  expect(screen.queryByRole("listbox", { name: "Machines" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Machine:/ })).toBeNull();
});

test("with this machine offline Add project works on the one machine that's online, and says so", async () => {
  const { made, build } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  act(() => made.daemon.refuseConnections(true));
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  const field = await screen.findByRole("combobox", { name: "Folder path" });
  await userEvent.clear(field);
  await userEvent.type(field, "~/services/api/");
  await screen.findByText("~/services/api");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(paths(build)).toEqual(["/home/ci/services/api"]));
});

test("Back from Clone keeps the GitHub search", async () => {
  const made = harness({ throughWorker: true });
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/code" }]);
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "GitHub repository" }));
  await screen.findByRole("option", { name: /ada\/engine/ });
  await userEvent.type(
    screen.getByRole("combobox", { name: "Search GitHub repositories" }),
    "docs",
  );
  // Rows from the last search can't be chosen until this one comes back.
  await waitFor(() => expect(screen.queryByRole("option", { name: /ada\/engine/ })).toBeNull());
  await userEvent.click(await screen.findByRole("option", { name: /ace-org\/docs/ }));
  await screen.findByRole("textbox", { name: "Repository address" });

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  const search = await screen.findByRole("combobox", { name: "Search GitHub repositories" });
  expect(search).toHaveProperty("value", "docs");
  expect(screen.queryByRole("option", { name: /ada\/engine/ })).toBeNull();
});

test("a reconnect of this machine keeps the open step on this machine", async () => {
  const { made, build } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const field = await screen.findByRole("combobox", { name: "Folder path" });
  await userEvent.clear(field);
  await userEvent.type(field, "~/code/");

  // While this machine reconnects the build server is the only one online: the step stays here.
  act(() => made.daemon.refuseConnections(true));
  await waitFor(() =>
    expect(
      screen.queryByText("This Mac isn't connected. Folders come back once it is."),
    ).toBeTruthy(),
  );
  expect(screen.getByRole("combobox", { name: "Folder path" })).toHaveProperty("value", "~/code/");
  await userEvent.keyboard("{Enter}");
  act(() => made.daemon.refuseConnections(false));

  const again = await screen.findByRole("combobox", { name: "Folder path" });
  expect(again).toHaveProperty("value", "~/code/");
  expect(await screen.findByRole("button", { name: "Machine: This Mac" })).toBeTruthy();
  expect(paths(build)).toEqual([]);
});

test("a clone running on the build server shows only on its Clone step; this machine's says where it runs", async () => {
  const stages: (() => void)[] = [];
  const { made } = twoMachines({ projectScheduler: (callback) => void stages.push(callback) });
  await addProjectOn(made, "Build server", "Git URL");
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Repository address" }),
    "acme/big-repo",
  );
  await screen.findByText("~/big-repo");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await screen.findByText(/Cloning acme\/big-repo on/);

  await pick("This Mac");
  const here = await screen.findByRole("textbox", { name: "Repository address" });
  expect(here).toHaveProperty("value", "");
  expect(here.hasAttribute("disabled")).toBe(false);
  expect(screen.getByText("A clone is running on Build server.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clone" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Cancel clone" })).toBeNull();

  // Back on the build server its address field is disabled, so its Cancel clone takes focus.
  await pick("Build server");
  const cancel = await screen.findByRole("button", { name: "Cancel clone" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  await userEvent.click(cancel);
  await waitFor(() => expect(screen.queryByText(/Cloning acme\/big-repo/)).toBeNull());
});
