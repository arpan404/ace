import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const home = "/home/dev";

function host() {
  const made = harness();
  made.daemon.projects.seedFolders(home, [
    { path: `${home}/code/weather`, git: true },
    { path: `${home}/code/mono`, git: true },
    { path: `${home}/code/mono/packages/web` },
  ]);
  return made;
}
const registered = (made: ReturnType<typeof harness>) =>
  made.daemon.projects.list().workspaces.map((project) => project.path);

/** The desktop app's preload bridge, as far as folders go. */
function desktopBridge(paths: { chosen?: string | null; dropped?: string }) {
  Object.assign(globalThis, {
    ace: {
      daemon: { status: async () => ({ source: "app" }) },
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
  expect(await within(dialog).findByText(/ace isn't allowed to open this folder yet/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Go to the home folder" }));
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
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Open a folder" }));
  await userEvent.click(await screen.findByRole("button", { name: "Choose a folder…" }));
  await screen.findByRole("button", { name: "Project: weather" });
  expect(registered(made)).toEqual([`${home}/code/weather`]);
});
