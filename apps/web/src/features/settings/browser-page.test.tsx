import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The desktop's preload bridge: its own settings file and its native folder picker. */
function desktop(picked: string | null) {
  let stored: Record<string, unknown> = {
    background: true,
    openAtLogin: false,
    notifications: { enabled: true, categories: {}, quietHours: null },
    browserDownloads: null,
  };
  const listeners = new Set<(value: unknown) => void>();
  vi.stubGlobal("ace", {
    settings: {
      get: async () => stored,
      update: async (patch: Record<string, unknown>) => {
        stored = { ...stored, ...patch };
        for (const listener of listeners) listener(stored);
        return stored;
      },
      onChange: (listener: (value: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dialogs: { openFolder: async () => picked },
    files: { pathForFile: () => null },
  });
  return { stored: () => stored };
}

const section = (name: RegExp) => {
  const heading = screen.getByText(name);
  const card = heading.closest("section");
  if (!card) throw new Error(`No section for ${String(name)}`);
  return within(card);
};

test("ace's Chrome saves to the daemon machine's Downloads folder unless the person names another", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "browser.downloadDefault": "/Users/dev/Downloads" });
  await app.open("/settings/browser");
  const field = await screen.findByRole("textbox", { name: "Downloads folder for ace's Chrome" });
  expect(field.getAttribute("placeholder")).toBe("/Users/dev/Downloads");
  expect(screen.getByText("Empty uses this machine's Downloads folder.")).toBeTruthy();

  await userEvent.type(field, "/Volumes/Work/downloads{Enter}");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("browser.downloadDir")).toBe("/Volumes/Work/downloads"),
  );
});

test("when the daemon's Downloads folder can't be used, Settings says downloads stay with each thread", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "browser.downloadDefault": "" });
  await app.open("/settings/browser");
  const field = await screen.findByRole("textbox", { name: "Downloads folder for ace's Chrome" });
  expect(field.getAttribute("placeholder")).toBe("With each thread");
  expect(screen.getByText(/empty keeps them with each thread/)).toBeTruthy();
});

test("the desktop app's own browser keeps its downloads folder in the app, chosen with its picker", async () => {
  const machine = desktop("/Users/me/Desktop/From ace");
  const app = harness();
  await app.open("/settings/browser");
  await screen.findByText("Downloads folder for the desktop app");
  const window = section(/^In this window$/);
  expect(window.getByText(/^Your Downloads folder\./)).toBeTruthy();
  // The machine's folder for ace's Chrome is a different row, named for what it serves.
  expect(screen.getByText("Downloads folder for ace's Chrome")).toBeTruthy();

  await userEvent.click(window.getByRole("button", { name: "Choose folder…" }));
  await waitFor(() => expect(machine.stored().browserDownloads).toBe("/Users/me/Desktop/From ace"));
  expect(await window.findByText(/^\/Users\/me\/Desktop\/From ace\./)).toBeTruthy();
  // The daemon's setting is untouched: each scope keeps its own folder.
  expect(app.daemon.services.settings.get("browser.downloadDir")).toBe("");

  await userEvent.click(window.getByRole("button", { name: "Use default" }));
  await waitFor(() => expect(machine.stored().browserDownloads).toBeNull());
});

test("how this window shows pages is set on Settings › Browser, no longer on General", async () => {
  const app = harness();
  await app.open("/settings/browser");
  await screen.findByText("In this window");
  const window = section(/^In this window$/);
  for (const name of [
    "Device toolbar in new tabs",
    "Picture in picture",
    "Open the browser panel when an agent opens a page",
    "Show Extensions button",
    "Show connection stats",
  ])
    expect(window.getByRole("switch", { name })).toBeTruthy();

  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("link", {
      name: "General",
    }),
  );
  await screen.findByRole("heading", { name: "General", level: 2 });
  expect(screen.queryByRole("switch", { name: "Picture in picture" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "Device toolbar in new tabs" })).toBeNull();
});

test("browsers share one global profile until the person keeps sign-ins per project", async () => {
  const app = harness();
  await app.open("/settings/browser");
  const scope = await screen.findByRole("combobox", { name: "Browser profile" });
  expect(scope.textContent).toContain("Global");
  expect(screen.getByText(/A project can choose its own in Edit project/)).toBeTruthy();

  await userEvent.click(scope);
  await userEvent.click(await screen.findByRole("option", { name: "Each project" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("browser.profileScope")).toBe("project"),
  );
});

test("in a browser there is no app folder to choose, and the person's Chrome decides for itself", async () => {
  const app = harness();
  await app.open("/settings/browser");
  await screen.findByRole("textbox", { name: "Downloads folder for ace's Chrome" });
  expect(await screen.findByText(/Downloads save where your Chrome saves them/)).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Picture in picture" })).toBeTruthy();
  expect(screen.queryByText("Downloads folder for the desktop app")).toBeNull();
});

test("Use my Chrome is installed and controlled from Settings › Browser, not Computer use", async () => {
  const app = harness();
  await app.open("/settings/browser");
  await screen.findByText("Browser connection");
  const chrome = section(/^Use my Chrome$/);
  expect(document.getElementById("browser.userChrome.connection")?.textContent).toContain(
    "Browser connection",
  );
  await userEvent.click(chrome.getByRole("button", { name: "Install" }));
  expect(await chrome.findByRole("switch", { name: /Let agents read cookies/ })).toBeTruthy();
  expect(chrome.getByRole("button", { name: "Revoke" })).toBeTruthy();

  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("link", {
      name: "Computer use",
    }),
  );
  await screen.findByRole("heading", { name: "Computer use", level: 2 });
  expect(screen.queryByText("Use my Chrome")).toBeNull();
  expect(screen.queryByText("Browser connection")).toBeNull();
});

test("searching for Use my Chrome lands on Settings › Browser", async () => {
  const { searchSettings } = await import("./settings-index.ts");
  const found = searchSettings("use my chrome").map((entry) => entry.page);
  expect(found.length).toBeGreaterThan(0);
  expect(new Set(found)).toEqual(new Set(["/settings/browser"]));
});
