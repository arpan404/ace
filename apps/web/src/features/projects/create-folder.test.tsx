import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const home = "/home/dev";

function host() {
  const made = harness();
  made.daemon.projects.seedFolders(home, [
    { path: `${home}/code/weather`, git: true },
    { path: `${home}/code/mono`, git: true },
  ]);
  return made;
}
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects.list().workspaces.map((project) => project.path);
const box = () => screen.findByRole("combobox", { name: "Search folders" });
const folders = () => screen.findByRole("listbox", { name: "Folders" });
/** The option the search box points at for assistive tech. */
const active = async () => {
  const id = (await box()).getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

/** ⇧⌘O from Settings: Add project on Open folder. */
async function openFolder(made: ReturnType<typeof harness>) {
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await screen.findByRole("dialog", { name: "Add project" });
  await userEvent.click(screen.getByRole("option", { name: "Local folder" }));
  return box();
}

test("a typed path that doesn't exist ends the list as the default, and Enter creates it and opens New thread there", async () => {
  const made = host();
  await userEvent.type(await openFolder(made), "~/code/kite");
  const create = await within(await folders()).findByRole("option", {
    name: "Create kite and add",
  });
  expect(create.textContent).toContain("~/code/kite");
  await waitFor(async () => expect(await active()).toBe(create));
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: kite" });
  expect(registered(made)).toEqual([`${home}/code/kite`]);
});

test("a path whose parent folders are missing too is created whole", async () => {
  const made = host();
  await userEvent.type(await openFolder(made), "~/clients/acme/site");
  const list = await folders();
  await within(list).findByRole("option", { name: "Create site and add" });
  expect(screen.queryByText(/doesn't exist/)).toBeNull();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: site" });
  expect(registered(made)).toEqual([`${home}/clients/acme/site`]);
});

test("a bare name is created beside the most recent project", async () => {
  const made = host();
  void made.client.start();
  await waitFor(() => expect(made.client.state).toBe("ready"));
  await made.client.projects.add({ path: `${home}/code/weather` });
  await userEvent.type(await openFolder(made), "sketchbook");
  const create = await within(await folders()).findByRole("option", {
    name: "Create sketchbook and add",
  });
  expect(create.textContent).toContain("~/code/sketchbook");
  await waitFor(async () => expect(await active()).toBe(create));
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: sketchbook" });
  expect(registered(made)).toContain(`${home}/code/sketchbook`);
});

test("a folder that exists is never offered for creating, and a matching folder stays the default", async () => {
  const made = host();
  const search = await openFolder(made);
  await userEvent.type(search, "~/code/weath");
  const list = await folders();
  await within(list).findByRole("option", { name: "Create weath and add" });
  expect((await active())?.textContent).toMatch(/^weather/);
  await userEvent.clear(search);
  await userEvent.type(search, "~/code/weather");
  await within(list).findByRole("option", { name: /^weather/ });
  expect(within(list).queryByRole("option", { name: /^Create/ })).toBeNull();
});

test("a folder created for another machine is made on that machine, not this one", async () => {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  made.daemon.projects.seedFolders(home, [{ path: `${home}/code/weather`, git: true }]);
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/services/api", git: true }]);
  await openFolder(made);
  await userEvent.keyboard("{Control>}m{/Control}");
  await userEvent.type(await box(), "~/services/queue");
  await within(await folders()).findByRole("option", { name: "Create queue and add" });
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(build.projects.list().workspaces.map((project) => project.path)).toEqual([
      "/home/ci/services/queue",
    ]),
  );
  expect(registered(made)).toEqual([]);
});

test("New thread's project search creates a missing folder and selects it", async () => {
  const made = host();
  void made.client.start();
  await waitFor(() => expect(made.client.state).toBe("ready"));
  const weather = await made.client.projects.add({ path: `${home}/code/weather` });
  await made.open(`/new?project=${weather.workspace?.id ?? ""}`);
  await userEvent.click(await screen.findByRole("button", { name: "Project: weather" }));
  const popup = await screen.findByRole("dialog", { name: "Choose project" });
  await userEvent.type(
    await within(popup).findByRole("combobox", { name: "Search projects" }),
    "~/code/orbit",
  );
  const create = await within(popup).findByRole("option", { name: "Create orbit and add" });
  expect(create.textContent).toContain("~/code/orbit");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: orbit" });
  expect(registered(made)).toEqual([`${home}/code/weather`, `${home}/code/orbit`]);
});

test("Settings offers to create a missing project folder, and Enter creates and allows it", async () => {
  const made = host();
  await made.open("/settings/general");
  const field = await screen.findByRole("textbox", { name: "Folder path" });
  await userEvent.type(field, "~/work{Enter}");
  await screen.findByRole("button", { name: "Create work and add" });
  expect(made.daemon.services.settings.isSet("projects.roots")).toBe(false);
  await userEvent.type(field, "{Enter}");
  expect(await screen.findByRole("button", { name: `Actions for ${home}/work` })).toBeTruthy();
  expect(made.daemon.services.settings.get("projects.roots")).toEqual([home, `${home}/work`]);
});
