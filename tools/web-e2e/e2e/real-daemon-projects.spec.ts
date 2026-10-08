import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  clonedFile,
  cloneUrl,
  daemonPort,
  daemonTokenPath,
  existingFolder,
  linkedFolder,
  projectsRoot,
} from "../src/real-daemon-config.ts";

/**
 * Projects against a real apps/daemon (src/real-daemon.ts): Open folder, Create new with
 * `git init`, Clone with progress and Cancel, Rename and Remove, and the `/new?folder=` deep
 * link. Each journey checks the folder on disk too. The clone reaches a local bare repository
 * through Git's file transport, which the e2e daemon alone allows; nothing leaves the machine.
 * Project names start with "proj-" so the seeded project stays first in other journeys' pickers.
 */
const handoff = () => {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  return `#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`;
};
async function connect(page: Page, path = "/new") {
  await page.goto(`${path}${handoff()}`);
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
}
const root = () => realpathSync(projectsRoot);
const dialog = (page: Page) => page.getByRole("dialog", { name: "Add project" });
const workingIn = (page: Page, name: string) =>
  expect(page.getByRole("button", { name: `Project: ${name}` })).toBeVisible({
    timeout: 30_000,
  });

async function openAddProject(page: Page, tab: "Open folder" | "Create new" | "Clone repository") {
  await page.keyboard.press("ControlOrMeta+Shift+o");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("tab", { name: tab }).click();
}

test("Open folder browses the daemon's folders and starts New thread in the one chosen", async ({
  page,
}) => {
  await connect(page);
  await openAddProject(page, "Open folder");
  const folders = dialog(page).getByRole("listbox", { name: "Folders" });
  await folders.getByRole("option", { name: new RegExp(`^${existingFolder}`) }).click();
  // The daemon saw the repository inside it.
  await expect(
    folders.getByRole("option", { name: new RegExp(`^${existingFolder}.*Git`) }),
  ).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: `Add ${existingFolder}` })
    .click();
  await workingIn(page, existingFolder);
});

test("Create new makes the folder, runs git init on the chosen branch and opens it", async ({
  page,
}) => {
  await connect(page);
  await openAddProject(page, "Create new");
  await dialog(page).getByRole("textbox", { name: "Name" }).fill("proj-created");
  await expect(dialog(page).getByText("Creates ~/proj-created")).toBeVisible();
  await dialog(page).getByRole("textbox", { name: "Initial branch" }).fill("trunk");
  await dialog(page).getByRole("button", { name: "Create project" }).click();
  await workingIn(page, "proj-created");

  const head = readFileSync(join(root(), "proj-created", ".git", "HEAD"), "utf8");
  expect(head.trim()).toBe("ref: refs/heads/trunk");
});

test("Clone shows Git's progress, then the cloned files are a project", async ({ page }) => {
  await connect(page);
  await openAddProject(page, "Clone repository");
  await dialog(page).getByRole("textbox", { name: "Repository address" }).fill(cloneUrl);
  const folder = dialog(page).getByRole("textbox", { name: "Folder name" });
  await expect(folder).toHaveValue("sample");
  await folder.fill("proj-cloned");
  await dialog(page).getByRole("button", { name: "Clone", exact: true }).click();

  const bar = dialog(page).getByRole("progressbar", { name: "Clone progress" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuetext", /Receiving objects, \d+%/);
  await workingIn(page, "proj-cloned");
  expect(existsSync(join(root(), "proj-cloned", clonedFile))).toBe(true);
});

test("Cancel stops a clone, and nothing is added", async ({ page }) => {
  await connect(page);
  await openAddProject(page, "Clone repository");
  await dialog(page).getByRole("textbox", { name: "Repository address" }).fill(cloneUrl);
  await dialog(page).getByRole("textbox", { name: "Folder name" }).fill("proj-cancelled");
  await dialog(page).getByRole("button", { name: "Clone", exact: true }).click();
  await expect(dialog(page).getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    /Receiving objects/,
  );
  await dialog(page).getByRole("button", { name: "Cancel clone" }).click();

  await expect(dialog(page).getByRole("progressbar")).toHaveCount(0, { timeout: 20_000 });
  await expect(dialog(page).getByRole("button", { name: "Clone", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Project:/ }).click();
  await expect(page.getByRole("menuitemradio", { name: "proj-cancelled" })).toHaveCount(0);
});

test("ace://open?folder= (as /new?folder=) opens New thread in the folder; rename and remove keep it on disk", async ({
  page,
}) => {
  const folder = join(root(), linkedFolder);
  await connect(page, `/new?folder=${encodeURIComponent(folder)}`);
  await workingIn(page, linkedFolder);

  // Show only this project on Home; its menu renames and removes it.
  const filter = page.getByRole("button", { name: /^Project filter:/ });
  await filter.click();
  await page.getByRole("menuitemradio", { name: linkedFolder }).click();
  await page.getByRole("menuitem", { name: `Rename ${linkedFolder}…` }).click();
  const rename = page.getByRole("dialog", { name: `Rename ${linkedFolder}` });
  await rename.getByRole("textbox", { name: "Name" }).fill("proj-renamed");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("button", { name: "Project filter: proj-renamed" })).toBeVisible();

  await page.getByRole("button", { name: "Project filter: proj-renamed" }).click();
  await page.getByRole("menuitem", { name: "Remove proj-renamed…" }).click();
  const remove = page.getByRole("dialog", { name: "Remove proj-renamed?" });
  await expect(remove.getByText(/This won't delete any files/)).toBeVisible();
  await remove.getByRole("button", { name: "Remove project" }).click();
  await expect(page.getByRole("button", { name: "Project filter: All projects" })).toBeVisible();
  await page.getByRole("button", { name: "Project filter: All projects" }).click();
  await expect(page.getByRole("menuitemradio", { name: "proj-renamed" })).toHaveCount(0);
  expect(existsSync(folder)).toBe(true);
});
