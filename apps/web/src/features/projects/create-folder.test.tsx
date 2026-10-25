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
const field = () => screen.findByRole<HTMLInputElement>("combobox", { name: "Folder path" });
const folders = () => screen.findByRole("listbox", { name: "Folders" });
/** The option the field points at for assistive tech, if any. */
const active = async () => {
  const id = (await field()).getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

/** ⇧⌘O from Settings, then Local folder: the path field, emptied. */
async function localFolder(made: ReturnType<typeof harness>) {
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await screen.findByRole("dialog", { name: "Add project" });
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const input = await field();
  await userEvent.clear(input);
  return input;
}

test("a path whose parent folders are missing too is offered whole, and made only when chosen", async () => {
  const made = host();
  await userEvent.type(await localFolder(made), "~/clients/acme/site");
  const create = await within(await folders()).findByRole("option", {
    name: "Create ~/clients/acme/site and add",
  });
  expect(await active()).toBeNull();
  expect(screen.queryByText(/doesn't exist/)).toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(registered(made)).toEqual([]);
  await userEvent.keyboard("{ArrowDown}");
  expect(await active()).toBe(create);
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: site" });
  expect(registered(made)).toEqual([`${home}/clients/acme/site`]);
});

test("a folder that exists is never offered for creating", async () => {
  const made = host();
  const input = await localFolder(made);
  await userEvent.type(input, "~/code/weath");
  const list = await folders();
  await within(list).findByRole("option", { name: "Create ~/code/weath and add" });
  await within(list).findByRole("option", { name: "weather" });
  await userEvent.clear(input);
  await userEvent.type(input, "~/code/weather");
  await within(list).findByRole("option", { name: "weather" });
  expect(within(list).queryByRole("option", { name: /^Create/ })).toBeNull();
});

test("a folder created for another machine is made on that machine, not this one", async () => {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  made.daemon.projects.seedFolders(home, [{ path: `${home}/code/weather`, git: true }]);
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/services/api", git: true }]);
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Build server" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const input = await field();
  await userEvent.clear(input);
  await userEvent.type(input, "~/services/queue");
  await within(await folders()).findByRole("option", { name: "Create ~/services/queue and add" });
  await userEvent.keyboard("{ArrowUp}{Enter}");
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
  // Project folders are an Agents setting.
  await made.open("/settings/agents");
  const box = await screen.findByRole("textbox", { name: "Folder path" });
  await userEvent.type(box, "~/work{Enter}");
  await screen.findByRole("button", { name: "Create work and add" });
  expect(made.daemon.services.settings.isSet("projects.roots")).toBe(false);
  await userEvent.type(box, "{Enter}");
  expect(await screen.findByRole("button", { name: `Actions for ${home}/work` })).toBeTruthy();
  expect(made.daemon.services.settings.get("projects.roots")).toEqual([home, `${home}/work`]);
});
