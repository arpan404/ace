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
const folders = () => screen.findByRole("listbox", { name: "Folders" });
const option = async (name: string) => within(await folders()).findByRole("option", { name });

/** ⇧⌘O: with more than one machine, Add project asks which one first. */
async function addProjectOn(made: ReturnType<typeof harness>, machine: string, source: string) {
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  const machines = await screen.findByRole("listbox", { name: "Machines" });
  await userEvent.click(await within(machines).findByRole("option", { name: machine }));
  await userEvent.click(await screen.findByRole("option", { name: source }));
}

test("with two machines Add project asks which machine first, and its folders follow the choice", async () => {
  const { made } = twoMachines();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  const machines = await screen.findByRole("listbox", { name: "Machines" });
  await waitFor(() =>
    expect(
      within(machines)
        .getAllByRole("option")
        .map((each) => each.textContent),
    ).toEqual(["This Mac", "Build server"]),
  );
  await userEvent.click(within(machines).getByRole("option", { name: "Build server" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  expect(await option("services")).toBeTruthy();

  // The machine chip changes it again.
  await userEvent.click(screen.getByRole("button", { name: "Machine: Build server" }));
  await userEvent.click(
    within(await screen.findByRole("listbox", { name: "Machines" })).getByRole("option", {
      name: "This Mac",
    }),
  );
  expect(await option("code")).toBeTruthy();
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
  await screen.findByText("/srv/app");
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
