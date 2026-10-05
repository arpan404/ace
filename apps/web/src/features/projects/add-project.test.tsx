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
    { path: `${home}/code/design-tokens` },
    { path: `${home}/.dotfiles` },
  ]);
  return made;
}
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects.list().workspaces.map((project) => project.path);
const dialog = () => screen.findByRole("dialog", { name: "Add project" });
const box = () => screen.findByRole("combobox", { name: "Search folders" });
const folders = () => screen.findByRole("listbox", { name: "Folders" });
const option = async (name: string) =>
  within(await folders()).findByRole("option", { name: new RegExp(`^${name}`) });
/** The option the search box points at for assistive tech. */
const active = async () => {
  const id = (await box()).getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};
const names = (group: HTMLElement) =>
  within(group)
    .getAllByRole("option")
    .map((each) => each.textContent?.match(/^[\w.-]+/)?.[0]);

/** The selected tab's label. */
const selected = () =>
  screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.textContent;

/** A project registered before the app opens, as another device would have. */
async function addProject(made: ReturnType<typeof harness>, input: { path: string }) {
  void made.client.start();
  await waitFor(() => expect(made.client.state).toBe("ready"));
  return made.client.projects.add(input);
}

/** ⇧⌘O from Settings: Add project on Open folder. */
async function openFolder(made: ReturnType<typeof harness>) {
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await dialog();
  return box();
}

test("the first run offers the three ways in, and a searched folder opens with Enter", async () => {
  const made = firstRun();
  await made.open("/");
  await screen.findByRole("heading", { level: 1, name: "Add your first project" });
  expect(screen.getByRole("button", { name: "Create a project" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clone a repository" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open a folder" }));

  const search = await box();
  expect(document.activeElement).toBe(search);
  await userEvent.type(search, "weath");
  await option("weather");
  expect((await active())?.textContent).toMatch(/^weather/);
  await userEvent.keyboard("{Enter}");

  // A project with no threads yet opens at New thread.
  await screen.findByRole("heading", { name: "What should we work on in weather?" });
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});

test("search ranks an exact name, then a prefix, then a name containing it, then scattered letters", async () => {
  const made = harness();
  made.daemon.projects.seedFolders(home, [
    { path: `${home}/code/wide-eyed-bot` },
    { path: `${home}/code/my-web` },
    { path: `${home}/code/webapp` },
    { path: `${home}/web` },
  ]);
  await userEvent.type(await openFolder(made), "web");
  const list = await folders();
  await waitFor(() =>
    expect(names(within(list).getByRole("group", { name: "Folders on This machine" }))).toEqual([
      "web",
      "webapp",
      "my-web",
      "wide-eyed-bot",
    ]),
  );
});

test("a folder that is already a project is offered first, under Projects", async () => {
  const made = firstRun();
  await addProject(made, { path: `${home}/code/design-system` });
  await userEvent.type(await openFolder(made), "design");
  const list = await folders();
  const projects = await within(list).findByRole("group", { name: "Projects" });
  expect(names(projects)).toEqual(["design-system"]);
  await waitFor(() =>
    expect(names(within(list).getByRole("group", { name: /^Folders on/ }))).toEqual([
      "design-tokens",
    ]),
  );
});

test("typing a path browses it: Tab completes, / goes in, Backspace and ⌘↑ go up, Enter opens it", async () => {
  const made = firstRun();
  const search = await openFolder(made);
  await userEvent.type(search, "~/co");
  await userEvent.keyboard("{Tab}");
  // The only match: completed and entered.
  await waitFor(() => expect(search).toHaveProperty("value", "~/code/"));
  const path = screen.getByRole("navigation", { name: "Folder path" });
  expect(within(path).getByRole("button", { name: "code" }).getAttribute("aria-current")).toBe(
    "location",
  );
  await option("mono");

  // Several matches complete to what they share.
  await userEvent.type(search, "d");
  await userEvent.keyboard("{Tab}");
  await waitFor(() => expect(search).toHaveProperty("value", "~/code/design-"));
  await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
  expect(search).toHaveProperty("value", "~/code/");
  await userEvent.keyboard("{Backspace}");
  expect(search).toHaveProperty("value", "~/");
  // Backspace stops at the home folder, an allowed root, and edits the text as usual.
  await userEvent.keyboard("{Backspace}");
  expect(search).toHaveProperty("value", "~");

  // A breadcrumb goes straight to its folder.
  await userEvent.clear(search);
  await userEvent.type(search, "~/code/mono/packages/");
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Folder path" })).getByRole("button", {
      name: "mono",
    }),
  );
  expect(search).toHaveProperty("value", "~/code/mono/");
  // The typed folder itself comes first, so Enter opens it.
  await option("mono");
  await userEvent.click(search);
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { name: "What should we work on in mono?" });
  expect(registered(made)).toEqual([`${home}/code/mono`]);
});

test("arrows and Ctrl-N/P move the highlight, and Esc clears the box before closing", async () => {
  const made = firstRun();
  const search = await openFolder(made);
  await userEvent.type(search, "~/code/");
  await option("weather");
  expect((await active())?.textContent).toMatch(/^code/);
  await userEvent.keyboard("{ArrowDown}");
  expect((await active())?.textContent).toMatch(/^design-system/);
  await userEvent.keyboard("{Control>}n{/Control}");
  expect((await active())?.textContent).toMatch(/^design-tokens/);
  await userEvent.keyboard("{Control>}p{/Control}{ArrowUp}");
  expect((await active())?.textContent).toMatch(/^code/);
  // The highlighted folder's full path is shown and described to assistive tech.
  await userEvent.keyboard("{ArrowDown}");
  const described = document.getElementById(search.getAttribute("aria-describedby") ?? "");
  expect(described?.textContent).toBe("~/code/design-system");

  await userEvent.keyboard("{Escape}");
  expect(search).toHaveProperty("value", "");
  expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());
});

test("the search box and list read as a combobox with a listbox of grouped options", async () => {
  const made = firstRun();
  await addProject(made, { path: `${home}/code/weather` });
  const search = await openFolder(made);
  const list = await folders();
  expect(search.getAttribute("aria-controls")).toBe(list.id);
  expect(search.getAttribute("aria-expanded")).toBe("true");
  expect(search.getAttribute("aria-autocomplete")).toBe("list");
  await within(list).findByRole("group", { name: "Recent" });
  expect(within(list).getByRole("group", { name: "In ~" })).toBeTruthy();
  const options = within(list).getAllByRole("option");
  expect(options.filter((each) => each.getAttribute("aria-selected") === "true")).toEqual([
    await active(),
  ]);
  expect((await active())?.textContent).toMatch(/^weather.*~\/code\/weather.*Project/);
});

test("hidden folders show once the typed name starts with a dot", async () => {
  const made = firstRun();
  const search = await openFolder(made);
  await userEvent.type(search, "~/");
  await option("code");
  expect(within(await folders()).queryByRole("option", { name: /dotfiles/ })).toBeNull();
  await userEvent.type(search, ".");
  expect(await option(".dotfiles")).toBeTruthy();
});

test("a folder inside a repository offers the repository, added only when chosen", async () => {
  const made = firstRun();
  const search = await openFolder(made);
  await userEvent.type(search, "~/code/mono/packages/");
  await option("web");
  await userEvent.keyboard("{ArrowDown}");

  const offer = await screen.findByRole("note");
  expect(offer.textContent).toContain("web is inside the mono repository");
  await userEvent.click(within(offer).getByRole("button", { name: "Add mono" }));
  await screen.findByRole("heading", { name: "What should we work on in mono?" });
  expect(registered(made)).toEqual([`${home}/code/mono`]);
});

test("Enter opens a project with threads at its threads; ⌘Enter starts a new thread", async () => {
  const made = firstRun();
  const added = await addProject(made, { path: `${home}/code/weather` });
  const projectId = added.workspace?.id ?? "";
  made.daemon.createThread({
    id: "thread-forecast",
    workspaceId: projectId,
    title: "Fix the forecast",
    provider: "codex",
  });
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await box();
  await option("weather");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await screen.findByRole("heading", { name: "What should we work on in weather?" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());

  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await option("weather");
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { level: 1, name: "Fix the forecast" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());
  expect(screen.queryByRole("heading", { name: "What should we work on in weather?" })).toBeNull();
});

test("⌘1–⌘3 switch tabs, and so do ← and → from an empty box", async () => {
  const made = firstRun();
  await openFolder(made);
  await userEvent.keyboard("{Control>}2{/Control}");
  await waitFor(() => expect(selected()).toMatch(/^New project/));
  const name = await screen.findByRole("textbox", { name: "Name" });
  await waitFor(() => expect(document.activeElement).toBe(name));
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => expect(selected()).toMatch(/^Clone/));
  await userEvent.click(await screen.findByRole("textbox", { name: "Repository address" }));
  await userEvent.keyboard("{ArrowLeft}");
  await waitFor(() => expect(selected()).toMatch(/^New project/));
  // With text in the box the arrows move the caret instead.
  await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "x{ArrowLeft}");
  expect(selected()).toMatch(/^New project/);
  await userEvent.keyboard("{Control>}1{/Control}");
  await waitFor(() => expect(selected()).toMatch(/^Open folder/));
});

test("a new project's name is checked as you type, and it can start as a Git repository", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Create a project" }));
  await dialog();
  const name = screen.getByRole("textbox", { name: "Name" });
  await userEvent.type(name, "a/b");
  expect(await screen.findByText("A name can't contain / or \\.")).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "Code");
  // Folder names compare without case, as macOS does.
  expect(await screen.findByText("There's already a folder named Code here.")).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "forecast");
  expect(await screen.findByText("Creates ~/forecast")).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Initial branch" }), "trunk");
  await userEvent.click(screen.getByRole("button", { name: "Create project" }));

  await screen.findByRole("heading", { name: "What should we work on in forecast?" });
  const inspected = await made.client.projects.inspect(`${home}/forecast`);
  expect(inspected.result).toMatchObject({
    kind: "inspection",
    git: { root: `${home}/forecast`, branch: "trunk" },
  });
});

test("New project goes where the location search points, and ⌘Enter creates it", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Create a project" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "notes");
  const location = screen.getByRole("combobox", { name: "Search for a location" });
  await userEvent.type(location, "cod");
  await within(
    await screen.findByRole("listbox", { name: "Folders for the new project" }),
  ).findByRole("option", { name: /^code/ });
  // Enter goes into the folder rather than creating.
  await userEvent.keyboard("{Enter}");
  expect(location).toHaveProperty("value", "~/code/");
  await screen.findByText("Creates ~/code/notes");
  await userEvent.click(screen.getByRole("switch", { name: "Initialise a Git repository" }));
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await screen.findByRole("heading", { name: "What should we work on in notes?" });
  expect(registered(made)).toEqual([`${home}/code/notes`]);
});

test("while the daemon is away the dialog says so and adds nothing", async () => {
  const made = firstRun();
  await openFolder(made);
  await option("code");
  made.daemon.refuseConnections(true);
  made.daemon.disconnectAll();
  expect(await screen.findByText(/Reconnecting to the daemon… Folders and actions/)).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Select a folder" }).hasAttribute("disabled")).toBe(
      true,
    ),
  );
  expect(registered(made)).toEqual([]);
});

test("with home outside projects.roots, browsing opens the first root and adds from there", async () => {
  const made = harness();
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/srv/www/site", git: true }], {
    roots: ["/srv"],
  });
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));
  const search = await box();
  expect(within(await folders()).getByRole("group", { name: "In /srv" })).toBeTruthy();
  await userEvent.type(search, "/srv/www/");
  await option("site");
  await userEvent.keyboard("{ArrowDown}{Enter}");

  await screen.findByRole("heading", { name: "What should we work on in site?" });
  expect(registered(made)).toEqual(["/srv/www/site"]);
});

test("a home reached through a symlink still opens at home when a root holds its target", async () => {
  const made = harness();
  made.daemon.projects.seedFolders(
    "/mnt/users/dev",
    [{ path: "/mnt/users/dev/code/weather", git: true }, { path: "/srv/www" }],
    { roots: ["/srv", "/mnt/users"], homeLink: "/home/dev" },
  );
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));
  await dialog();
  expect(await option("code")).toBeTruthy();
  expect(within(await folders()).queryByRole("option", { name: /^www/ })).toBeNull();
});
