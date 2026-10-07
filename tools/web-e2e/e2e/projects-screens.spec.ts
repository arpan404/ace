import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The projects screens against the fake daemon, in Dark and Light at 1440x900, written to
 * /tmp/aceshots-web/projects-<screen>-<theme>.png: the first run, Add project on each tab,
 * a clone in progress and the project menu. Runs with the `screens` project.
 */
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-web";
mkdirSync(out, { recursive: true });

type Setup = (page: Page) => Promise<void>;
const dialog = (page: Page) => page.getByRole("dialog", { name: "Add project" });

/** New thread with Add project open on a tab. */
const addProject =
  (tab: "Open folder" | "Create new" | "Clone repository", then?: Setup): Setup =>
  async (page) => {
    await page.goto("/new");
    await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+o");
    await dialog(page).getByRole("tab", { name: tab }).click();
    await then?.(page);
  };

const screens: Record<string, Setup> = {
  // A daemon with no threads and no projects: provider setup first, then the first project.
  setup: async (page) => {
    await page.addInitScript(() => Object.assign(globalThis, { aceFakeWorld: "empty" }));
    await page.goto("/");
    await expect(page.getByRole("list", { name: "Providers on this computer" })).toBeVisible();
  },
  empty: async (page) => {
    await page.addInitScript(() => Object.assign(globalThis, { aceFakeWorld: "empty" }));
    await page.goto("/");
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("heading", { name: "Add your first project" })).toBeVisible();
  },
  open: addProject("Open folder", async (page) => {
    const folders = dialog(page).getByRole("listbox", { name: "Folders" });
    await folders.getByRole("option", { name: /^Code/ }).dblclick();
    await folders.getByRole("option", { name: /^design-system/ }).dblclick();
    await folders.getByRole("option", { name: /^packages/ }).dblclick();
    await folders.getByRole("option", { name: /^tokens/ }).click();
    // The folder is inside a repository: its root is offered.
    await expect(dialog(page).getByRole("button", { name: "Add design-system" })).toBeVisible();
  }),
  create: addProject("Create new", async (page) => {
    await dialog(page).getByRole("textbox", { name: "Name" }).fill("weather-station");
    await dialog(page).getByRole("button", { name: "Change…" }).click();
    await dialog(page)
      .getByRole("listbox", { name: "Folders for the new project" })
      .getByRole("option", { name: /^Code/ })
      .dblclick();
    await expect(dialog(page).getByText("Creates ~/Code/weather-station")).toBeVisible();
  }),
  clone: addProject("Clone repository", async (page) => {
    await dialog(page)
      .getByRole("textbox", { name: "Repository address" })
      .fill("git@github.com:acme/billing-dashboard.git");
    await expect(dialog(page).getByRole("textbox", { name: "Folder name" })).toHaveValue(
      "billing-dashboard",
    );
  }),
  "clone-progress": addProject("Clone repository", async (page) => {
    await dialog(page)
      .getByRole("textbox", { name: "Repository address" })
      .fill("https://github.com/acme/billing-dashboard.git");
    await dialog(page).getByRole("button", { name: "Clone", exact: true }).click();
    await expect(dialog(page).getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "Receiving objects, 52%",
    );
  }),
  "clone-auth": addProject("Clone repository", async (page) => {
    await dialog(page)
      .getByRole("textbox", { name: "Repository address" })
      .fill("https://me:token@github.com/acme/private.git");
    await expect(dialog(page).getByText(/your own Git credentials/)).toBeVisible();
  }),
  manage: async (page) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("ace.home.lastThread"))
        localStorage.setItem("ace.home.lastThread", JSON.stringify("thread-dedupe"));
    });
    await page.goto("/");
    await page.waitForURL(/\/t\//);
    await page.getByRole("button", { name: /^Project filter:/ }).click();
    await page.getByRole("menuitemradio", { name: "ace", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Remove ace…" })).toBeVisible();
  },
  remove: async (page) => {
    await page.goto("/new");
    await page.getByRole("button", { name: /^Project filter:/ }).click();
    await page.getByRole("menuitemradio", { name: "relay", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove relay…" }).click();
    await page
      .getByRole("dialog", { name: "Remove relay?" })
      .getByRole("button", {
        name: "Remove project",
      })
      .click();
    // relay has threads still working: removing it means archiving them.
    await expect(page.getByRole("button", { name: "Archive threads and remove" })).toBeVisible();
  },
};

for (const theme of ["dark", "light"] as const)
  for (const [name, setup] of Object.entries(screens))
    test(`projects ${name} in ${theme}`, async ({ page }) => {
      await page.addInitScript((id) => {
        if (!localStorage.getItem("ace.appearance"))
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: id }));
      }, theme);
      await setup(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/projects-${name}-${theme}.png` });
    });
