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
    { path: `${home}/.dotfiles` },
  ]);
  return made;
}
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects.list().workspaces.map((project) => project.path);
const dialog = () => screen.findByRole("dialog", { name: "Add project" });
const folders = () => screen.findByRole("listbox", { name: "Folders" });
const option = async (name: string) =>
  within(await folders()).findByRole("option", { name: new RegExp(`^${name}`) });

test("the first run offers the three ways in, and an opened folder starts New thread there", async () => {
  const made = firstRun();
  await made.open("/");
  await screen.findByRole("heading", { level: 1, name: "Add your first project" });
  expect(screen.getByRole("button", { name: "Create a project" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clone a repository" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open a folder" }));

  await dialog();
  // Hidden folders stay out of the way until asked for.
  expect(within(await folders()).queryByRole("option", { name: /dotfiles/ })).toBeNull();
  await userEvent.dblClick(await option("code"));
  await userEvent.click(await option("weather"));
  expect((await option("weather")).getAttribute("aria-selected")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Add weather" }));

  await screen.findByRole("heading", { name: "What should we work on in weather?" });
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});

test("the folder list moves with the keyboard: arrows select, Enter opens, Backspace goes up", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));
  const list = await folders();
  list.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect((await option("code")).getAttribute("aria-selected")).toBe("true");
  await userEvent.keyboard("{Enter}");
  await option("mono");
  expect(
    within(screen.getByRole("navigation", { name: "Folder path" })).getByRole("button", {
      name: "code",
    }),
  ).toBeTruthy();
  (await folders()).focus();
  await userEvent.keyboard("{Backspace}");
  await option("code");
});

test("hidden folders show on request", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));
  await folders();
  await userEvent.click(screen.getByRole("checkbox", { name: "Hidden folders" }));
  expect(await option(".dotfiles")).toBeTruthy();
});

test("a folder inside a repository offers the repository, added only when chosen", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));
  await userEvent.dblClick(await option("code"));
  await userEvent.dblClick(await option("mono"));
  await userEvent.dblClick(await option("packages"));
  await userEvent.click(await option("web"));

  const offer = await screen.findByRole("note");
  expect(offer.textContent).toContain("web is inside the mono repository");
  await userEvent.click(within(offer).getByRole("button", { name: "Add mono" }));
  await screen.findByRole("heading", { name: "What should we work on in mono?" });
  expect(registered(made)).toEqual([`${home}/code/mono`]);
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
  expect(screen.getByRole("switch", { name: "Initialise a Git repository" })).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Initial branch" }), "trunk");
  await userEvent.click(screen.getByRole("button", { name: "Create project" }));

  await screen.findByRole("heading", { name: "What should we work on in forecast?" });
  const inspected = await made.client.projects.inspect(`${home}/forecast`);
  expect(inspected.result).toMatchObject({
    kind: "inspection",
    git: { root: `${home}/forecast`, branch: "trunk" },
  });
});

test("Create new puts the project where the location browser points", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Create a project" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "notes");
  await userEvent.click(screen.getByRole("button", { name: "Change…" }));
  const list = await screen.findByRole("listbox", { name: "Folders for the new project" });
  await userEvent.dblClick(within(list).getByRole("option", { name: /^code/ }));
  await screen.findByText("Creates ~/code/notes");
  await userEvent.click(screen.getByRole("switch", { name: "Initialise a Git repository" }));
  await userEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { name: "What should we work on in notes?" });
  expect(registered(made)).toEqual([`${home}/code/notes`]);
});

test("⇧⌘O opens Add project from anywhere", async () => {
  const made = firstRun();
  await made.open("/settings");
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  expect(await dialog()).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Open folder" }).getAttribute("aria-selected")).toBe(
    "true",
  );
});

test("while the daemon is away the dialog says so and adds nothing", async () => {
  const made = firstRun();
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));
  await option("code");
  made.daemon.refuseConnections(true);
  made.daemon.disconnectAll();
  expect(await screen.findByText(/Reconnecting to the daemon… Folders and actions/)).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Select a folder" }).hasAttribute("disabled")).toBe(
      true,
    ),
  );
});

test("with home outside projects.roots, browsing opens the first root and adds from there", async () => {
  const made = harness();
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/srv/www/site", git: true }], {
    roots: ["/srv"],
  });
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));

  await dialog();
  await userEvent.dblClick(await option("www"));
  await userEvent.click(await option("site"));
  await userEvent.click(screen.getByRole("button", { name: "Add site" }));

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
