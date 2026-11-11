import { SettingsValues } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fallback } from "@/boot/connection.tsx";
import { createMemoryHistory } from "@tanstack/react-router";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

const home = "/home/dev";

const localTarget = { url: "ws://127.0.0.1:4242/", token: "a".repeat(64) };
function host(remote = false, options: Parameters<typeof harness>[0] = {}) {
  const made = harness({
    ...options,
    connection: {
      ...fallback,
      mode: "daemon",
      endpoint: {
        kind: "daemon",
        target: remote ? { ...localTarget, url: "wss://remote.example/" } : localTarget,
        deviceId: "test-device",
      },
    },
  });
  made.daemon.projects.seedFolders(home, [
    { path: `${home}/code/weather`, git: true },
    { path: `${home}/code/mono`, git: true },
    { path: `${home}/code/mono/packages/web` },
  ]);
  return made;
}
/** The projects the person can see: a chat's hidden project (ADR 0099) is not one they added. */
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects
    .list()
    .workspaces.filter((project) => project.kind !== "chat")
    .map((project) => project.path);

/** The desktop app's preload bridge, as far as folders go. */
function desktopBridge(paths: { chosen?: string | null; dropped?: string }) {
  Object.assign(globalThis, {
    ace: {
      daemon: {
        status: async () => ({ state: "running", source: "app" }),
        connection: async () => ({ mode: "daemon", ...localTarget }),
      },
      dialogs: { openFolder: async () => paths.chosen ?? null },
      files: { pathForFile: () => paths.dropped ?? "" },
    },
  });
}
afterEach(() => {
  Reflect.deleteProperty(globalThis, "ace");
});

/** A folder dropped on the window, the way Chromium reports one. */
function dropFolder(name: string) {
  const file = new File([], name);
  const transfer = {
    types: ["Files"],
    dropEffect: "none",
    items: [
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => file },
    ],
  };
  for (const type of ["dragover", "drop"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    document.body.dispatchEvent(event);
  }
}

test("/new?folder= adds the folder and opens New thread in it", async () => {
  const made = host();
  await made.open(`/new?folder=${encodeURIComponent(`${home}/code/weather`)}`);
  await screen.findByRole("button", { name: "Project: weather" });
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});

test("opening a folder that is already a project selects it rather than adding another", async () => {
  const made = host();
  await made.open(`/new?folder=${encodeURIComponent(`${home}/code/weather`)}`);
  await screen.findByRole("button", { name: "Project: weather" });
  await made.open(`/new?folder=${encodeURIComponent(`${home}/code/weather/`)}`);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Project: weather" })).toHaveLength(2),
  );
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});

test("a folder the daemon may not open says why and offers another, inside the allowed places", async () => {
  const made = host();
  await made.open(`/new?folder=${encodeURIComponent("/etc/ssh")}`);
  await screen.findByRole("heading", { name: "Couldn't open ssh" });
  expect(screen.getByText(/ace isn't allowed to open this folder yet/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Choose another folder…" }));

  const dialog = await screen.findByRole("dialog", { name: "Add project" });
  // The browser shows that folder's parent, which is just as closed off, and the way home.
  // (The chosen path may say the same of itself under the address.)
  const parent = await waitFor(() => {
    const listing = within(dialog)
      .getAllByRole("status")
      .find((status) => /ace isn't allowed to open this folder yet/.test(status.textContent ?? ""));
    if (!listing) throw new Error("The parent folder doesn't say why it is closed");
    return listing;
  });
  await userEvent.click(within(parent).getByRole("button", { name: "Go to the home folder" }));
  expect(await within(dialog).findByRole("option", { name: /^code/ })).toBeTruthy();
  expect(registered(made)).toEqual([]);
});

test("in the desktop app a folder dropped on the window becomes a project", async () => {
  desktopBridge({ dropped: `${home}/code/mono/packages/web` });
  const made = host();
  await made.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  dropFolder("web");

  await screen.findByRole("button", { name: "Project: web" });
  // A subfolder of a repository offers the repository too, added only if chosen.
  expect(await screen.findByText("It's inside the mono repository.")).toBeTruthy();
  expect(registered(made)).toEqual([`${home}/code/mono/packages/web`]);
  await userEvent.click(screen.getByRole("button", { name: "Use mono" }));
  await screen.findByRole("button", { name: "Project: mono" });
});

test("in a browser a dropped folder opens Add project, since the page can't know its path", async () => {
  const made = host();
  await made.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  dropFolder("weather");
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  expect(registered(made)).toEqual([]);
});

test("the desktop app's folder picker adds the chosen folder", async () => {
  desktopBridge({ chosen: `${home}/code/weather` });
  const made = host();
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  await userEvent.click(await screen.findByRole("button", { name: "Browse…" }));
  await screen.findByRole("button", { name: "Project: weather" });
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});

test("a refused native folder pick shows its exact path, and one action allows and adds it", async () => {
  const path = "/srv/private/project";
  desktopBridge({ chosen: path });
  const made = host();
  made.daemon.projects.seedFolders(home, [{ path: `${home}/code/weather`, git: true }, { path }], {
    roots: [home, "/srv"],
  });
  await made.client.start();
  await waitFor(() => expect(made.client.state).toBe("ready"));
  await made.client.request({
    type: "settings.set",
    key: "projects.roots",
    value: [home],
    layer: { kind: "global" },
  });
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  await userEvent.click(await screen.findByRole("button", { name: "Browse…" }));
  const dialog = await screen.findByRole("dialog", { name: "Add project" });
  const failure = await within(dialog).findByRole("alert");
  expect(failure.textContent).toContain(path);
  expect(failure.textContent).toContain("ace isn't allowed to open this folder yet");
  await userEvent.click(within(failure).getByRole("button", { name: "Allow and add" }));
  await screen.findByRole("button", { name: "Project: project" });
  expect(registered(made)).toEqual([path]);
});

test("undo after allowing and adding a native pick takes back only the folder, keeping the project's threads", async () => {
  const path = "/srv/private/project";
  desktopBridge({ chosen: path });
  const made = host();
  made.daemon.projects.seedFolders(home, [{ path }], { roots: [home, "/srv"] });
  made.daemon.services.settings.seed({ "projects.roots": [home] });
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  await userEvent.click(await screen.findByRole("button", { name: "Browse…" }));
  const failure = await within(
    await screen.findByRole("dialog", { name: "Add project" }),
  ).findByRole("alert");
  await userEvent.click(within(failure).getByRole("button", { name: "Allow and add" }));
  await screen.findByRole("button", { name: "Project: project" });
  const project = made.daemon.projects.list().workspaces.find((each) => each.path === path);
  createIdleTask(made.daemon, {
    id: "thread-started-meanwhile",
    workspaceId: project?.id ?? "",
    title: "Started before the undo",
    provider: "codex",
  });
  // Settings, or another device, allows another place before the undo.
  const roots = () => made.daemon.services.settings.get("projects.roots");
  made.daemon.services.settings.write("projects.roots", [
    ...SettingsValues.shape["projects.roots"].parse(roots()),
    "/opt",
  ]);

  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(roots()).toEqual([home, "/opt"]));
  expect(made.daemon.projects.isRemoved(project?.id ?? "")).toBe(false);
  expect(registered(made)).toEqual([path]);
});

test("undo after allowing and adding closes the new project's draft to Home, since it's hidden", async () => {
  const path = "/srv/private/project";
  desktopBridge({ chosen: path });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const made = host(false, { history });
  made.daemon.projects.seedFolders(home, [{ path }], { roots: [home, "/srv"] });
  made.daemon.services.settings.seed({ "projects.roots": [home] });
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local folder" }));
  await userEvent.click(await screen.findByRole("button", { name: "Browse…" }));
  const failure = await within(
    await screen.findByRole("dialog", { name: "Add project" }),
  ).findByRole("alert");
  await userEvent.click(within(failure).getByRole("button", { name: "Allow and add" }));
  await screen.findByRole("button", { name: "Project: project" });
  expect(history.location.pathname).toBe("/new");

  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(history.location.pathname).toBe("/"));
  expect(screen.queryByRole("button", { name: "Project: project" })).toBeNull();
});

test("dropping a local folder on a remote primary offers remote browsing without registering its same-path folder", async () => {
  desktopBridge({ dropped: `${home}/code/weather` });
  const made = host(true);
  await made.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  dropFolder("weather");
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  expect(registered(made)).toEqual([]);
  expect(screen.queryByRole("button", { name: "Browse…" })).toBeNull();
});

test("a desktop folder link cannot register its local path on a selected remote daemon", async () => {
  desktopBridge({});
  const made = host(true);
  await made.open(`/new?folder=${encodeURIComponent(`${home}/code/weather`)}`);
  expect(
    await screen.findByText(
      "This folder is on this computer. Choose a folder on the connected machine instead.",
    ),
  ).toBeTruthy();
  expect(registered(made)).not.toContain(`${home}/code/weather`);
});
