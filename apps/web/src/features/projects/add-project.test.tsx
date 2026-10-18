import { createIdleTask } from "@/test/tasks.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const home = "/home/dev";

/** A daemon with no threads and no projects, and a few folders in the host's home. */
function firstRun(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options);
  made.daemon.projects.seedFolders(home, [
    { path: `${home}/code/weather`, git: true },
    { path: `${home}/code/mono`, git: true },
    { path: `${home}/code/mono/packages/web` },
    { path: `${home}/code/design-system`, git: true },
    { path: `${home}/.dotfiles` },
  ]);
  return made;
}
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects.list().workspaces.map((project) => project.path);
const palette = () => screen.findByRole("dialog", { name: "Add project" });
const field = () => screen.findByRole<HTMLInputElement>("combobox", { name: "Folder path" });
const folders = () => screen.findByRole("listbox", { name: "Folders" });
const option = async (name: string | RegExp) =>
  within(await folders()).findByRole("option", { name });
/** The option the field points at for assistive tech, if any. */
const highlighted = async () => {
  const id = (await field()).getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

/** A project registered before the app opens, as another device would have. */
async function addProject(made: ReturnType<typeof harness>, input: { path: string }) {
  void made.client.start();
  await waitFor(() => expect(made.client.state).toBe("ready"));
  return made.client.projects.add(input);
}

/** ⇧⌘O from Settings, then Local folder: the path field, emptied. */
async function localFolder(made: ReturnType<typeof harness>, path = "/settings") {
  await made.open(path);
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await palette();
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const input = await field();
  await userEvent.clear(input);
  return input;
}

test("⇧⌘O opens Add project in the palette on its four sources, the field focused", async () => {
  const made = firstRun();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  const sheet = await palette();
  // The step's chunk loads on demand.
  const sources = await within(sheet).findByRole("listbox", { name: "Project sources" });
  expect(
    within(sources)
      .getAllByRole("option")
      .map((each) => each.textContent),
  ).toEqual(["Local folder", "New project", "Git URL", "GitHub repository"]);
  const search = within(sheet).getByRole("combobox", { name: "Search project sources" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  // The first source is highlighted and Enter takes it.
  await userEvent.keyboard("{Enter}");
  expect((await field()).value).toBe("~/");
});

test("the first run's Add a project leads to the folder field, and ⌘Enter adds the highlighted folder", async () => {
  const made = firstRun();
  await made.open("/");
  await screen.findByRole("heading", { level: 1, name: "Add your first project" });
  await userEvent.click(
    within(screen.getByRole("main")).getByRole("button", { name: "Add a project" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const input = await field();
  expect(input.value).toBe("~/");
  await userEvent.type(input, "code/wea");
  await option("weather");
  // Nothing is highlighted until an arrow moves.
  expect(await highlighted()).toBeNull();
  await userEvent.keyboard("{ArrowDown}");
  expect((await highlighted())?.textContent).toMatch(/^weather/);
  await userEvent.keyboard("{Control>}{Enter}{/Control}");

  // Straight into a new thread draft in the project, with no extra step.
  await screen.findByRole("button", { name: "Project: weather" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());
  expect(registered(made)).toEqual([`${home}/code/weather`]);
  expect(screen.queryByText("Added weather")).toBeNull();
});

test("Enter on a name that doesn't exist creates nothing; only its Create row makes the folder", async () => {
  const made = firstRun();
  const input = await localFolder(made);
  await userEvent.type(input, "~/code/next");
  const create = await option("Create ~/code/next and add");
  // Offered, never highlighted on its own.
  expect(create.getAttribute("aria-selected")).toBe("false");
  await userEvent.keyboard("{Enter}");
  expect(registered(made)).toEqual([]);
  expect(await palette()).toBeTruthy();

  // Chosen deliberately, it makes the folder and adds it.
  await userEvent.keyboard("{ArrowUp}");
  expect((await highlighted())?.getAttribute("aria-label")).toBe("Create ~/code/next and add");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: next" });
  expect(registered(made)).toEqual([`${home}/code/next`]);
});

test("Enter, → and a click go into a folder, .. goes up, and Enter with nothing highlighted adds the typed folder", async () => {
  const made = firstRun();
  const input = await localFolder(made);
  await userEvent.type(input, "~/");
  await option("code");
  await userEvent.keyboard("{ArrowDown}");
  expect((await highlighted())?.textContent).toBe("..");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(input.value).toMatch(/^~\/[^/]+\/$/));

  await userEvent.clear(input);
  await userEvent.type(input, "~/code/wea");
  await option("weather");
  await userEvent.keyboard("{ArrowDown}{ArrowRight}");
  await waitFor(() => expect(input.value).toBe("~/code/weather/"));
  expect(registered(made)).toEqual([]);

  await userEvent.clear(input);
  await userEvent.type(input, "~/code/");
  await userEvent.click(await option("mono"));
  await waitFor(() => expect(input.value).toBe("~/code/mono/"));
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(input.value).toBe("~/code/"));
  expect(registered(made)).toEqual([]);

  await userEvent.type(input, "weather/");
  // The footer names what Enter adds once the folder is known to exist.
  await screen.findByText("~/code/weather");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: weather" });
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});

test("hidden folders show once the typed name starts with a dot", async () => {
  const made = firstRun();
  const input = await localFolder(made);
  await userEvent.type(input, "~/");
  await option("code");
  expect(within(await folders()).queryByRole("option", { name: /dotfiles/ })).toBeNull();
  await userEvent.type(input, ".");
  expect(await option(".dotfiles")).toBeTruthy();
});

test("the field starts beside the most recent project", async () => {
  const made = firstRun();
  await addProject(made, { path: `${home}/code/weather` });
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const input = await field();
  await waitFor(() => expect(input.value).toBe("~/code/"));
  expect(await option("mono")).toBeTruthy();
});

test("a folder that is already a project adds nothing and opens its latest thread", async () => {
  const made = firstRun();
  const added = await addProject(made, { path: `${home}/code/weather` });
  createIdleTask(made.daemon, {
    id: "thread-forecast",
    workspaceId: added.workspace?.id ?? "",
    title: "Fix the forecast",
    provider: "codex",
  });
  const input = await localFolder(made);
  await userEvent.type(input, "~/code/weather/");
  await screen.findByText("~/code/weather");
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { level: 1, name: "Fix the forecast" })).toBeTruthy();
  expect(await screen.findByText("weather is already a project")).toBeTruthy();
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});

test("a project without threads that is added again opens a new thread draft in it", async () => {
  const made = firstRun();
  await addProject(made, { path: `${home}/code/mono` });
  const input = await localFolder(made);
  await userEvent.type(input, "~/code/mono/");
  await screen.findByText("~/code/mono");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: mono" });
  expect(registered(made)).toEqual([`${home}/code/mono`]);
});

test("a folder inside a repository is added, and the repository is offered in the toast", async () => {
  const made = firstRun();
  const input = await localFolder(made);
  await userEvent.type(input, "~/code/mono/packages/web/");
  await screen.findByText("~/code/mono/packages/web");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Project: web" });
  expect(await screen.findByText("It's inside the mono repository.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Use mono" }));
  await screen.findByRole("button", { name: "Project: mono" });
  expect(registered(made)).toEqual([`${home}/code/mono/packages/web`, `${home}/code/mono`]);
});

test("Backspace in an empty field goes back a step, and Esc clears before it closes", async () => {
  const made = firstRun();
  const input = await localFolder(made);
  await userEvent.keyboard("{Backspace}");
  const sources = await screen.findByRole("combobox", { name: "Search project sources" });
  await userEvent.type(sources, "git");
  await userEvent.keyboard("{Escape}");
  expect(sources).toHaveProperty("value", "");
  expect(await palette()).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());
  expect(input.isConnected).toBe(false);
});

test("with home outside projects.roots, the field starts at the first root", async () => {
  const made = harness();
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/srv/www/site", git: true }], {
    roots: ["/srv"],
  });
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  const input = await field();
  await waitFor(() => expect(input.value).toBe("/srv/"));
  expect(await option("www")).toBeTruthy();
});

test("a folder outside the allowed places is allowed in one click, and Undo takes it back", async () => {
  const made = harness();
  made.daemon.projects.seedFolders("/fake", [{ path: "/external/site", git: true }], {
    roots: ["/fake", "/external"],
  });
  made.daemon.services.settings.seed({ "projects.roots": ["/fake"] });
  const input = await localFolder(made);
  await userEvent.type(input, "/external/");
  await userEvent.click(await screen.findByRole("button", { name: "Allow this folder" }));
  expect(await option("site")).toBeTruthy();
  expect(made.daemon.services.settings.get("projects.roots")).toEqual(["/fake", "/external"]);
  // No confirmation to get through, and the toast can undo it.
  expect(screen.queryByRole("dialog", { name: "Allow this folder?" })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(made.daemon.services.settings.get("projects.roots")).toEqual(["/fake"]),
  );
});

test("New project: the field is its name, checked as you type, and Enter creates a Git repository", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "New project" }));
  const name = await screen.findByRole("textbox", { name: "Project name" });
  await userEvent.type(name, "a/b");
  expect(await screen.findByText("A name can't contain / or \\.")).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "Code");
  // Folder names compare without case, as macOS does.
  expect(await screen.findByText("There's already a folder named Code here.")).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "forecast");
  expect(await screen.findByText("~/forecast")).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Initial branch" }), "trunk");
  await userEvent.click(name);
  await userEvent.keyboard("{Enter}");

  await screen.findByRole("button", { name: "Project: forecast" });
  const inspected = await made.client.projects.inspect(`${home}/forecast`);
  expect(inspected.result).toMatchObject({
    kind: "inspection",
    git: { root: `${home}/forecast`, branch: "trunk" },
  });
});

test("New project goes where the location search points, and ⌘Enter creates it", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "New project" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "Project name" }), "notes");
  const location = screen.getByRole("combobox", { name: "Search for a location" });
  await userEvent.type(location, "cod");
  await within(
    await screen.findByRole("listbox", { name: "Folders for the new project" }),
  ).findByRole("option", { name: /^code/ });
  // Enter goes into the folder rather than creating.
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(location).toHaveProperty("value", "~/code/");
  await screen.findByText("~/code/notes");
  await userEvent.click(screen.getByRole("switch", { name: "Initialise a Git repository" }));
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await screen.findByRole("button", { name: "Project: notes" });
  expect(registered(made)).toEqual([`${home}/code/notes`]);
});

test("sources narrow as you type and Enter opens the highlighted one", async () => {
  const made = firstRun();
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  const search = await screen.findByRole("combobox", { name: "Search project sources" });
  await userEvent.type(search, "git");
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("textbox", { name: "Repository address" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("combobox", { name: "Search project sources" });
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(await screen.findByRole("textbox", { name: "Project name" })).toBeTruthy();
});
