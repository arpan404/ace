import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const out = process.env.ACE_SHOTS_DIR ?? "/tmp/ace-orch/shots/ui/first-run-projects";
mkdirSync(out, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
}

for (const theme of ["light", "dark"])
  for (const width of [1440, 390]) {
    const suffix = `${theme}-${width}`;
    test(`first run leads directly to a project in ${suffix}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((preset) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset }));
        Object.assign(globalThis, { aceFakeWorld: "empty" });
      }, theme);
      await page.goto("/");
      await page.getByRole("button", { name: "Get started" }).click();
      const providers = page.getByRole("list", { name: "Providers on this computer" });
      await expect(providers).toBeVisible();
      await expect(providers.getByRole("listitem", { name: "Claude Code" })).toContainText(
        "Signed in",
      );
      await shot(page, `setup-${suffix}`);
      await page.getByRole("button", { name: "Add a project", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add project" });
      await expect(dialog.getByRole("combobox", { name: "Search folders" })).toBeFocused();
      await shot(page, `add-project-${suffix}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("heading", { name: "Add your first project" })).toBeVisible();
      await expect(
        page.getByRole("main").getByRole("button", { name: "Add a project" }),
      ).toHaveCount(1);
      await shot(page, `empty-${suffix}`);
      await page.getByRole("main").getByRole("button", { name: "Add a project" }).click();
      await dialog.getByRole("combobox", { name: "Search folders" }).fill("relay");
      await dialog
        .getByRole("option", { name: /^relay/ })
        .first()
        .dblclick();
      await expect(page.getByRole("heading", { name: "New thread", exact: true })).toBeVisible();
      await expect(page.getByText("Added relay", { exact: true })).toHaveCount(1);
    });

    test(`environment and project actions stay usable in ${suffix}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((preset) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset }));
      }, theme);
      await page.goto("/new");
      await expect(page.getByRole("combobox", { name: "Message" })).toBeVisible();
      if (width < 480) {
        await expect(page.getByRole("button", { name: "Environment", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /^Project:/ })).toHaveCount(0);
        await expect(page.getByRole("checkbox", { name: "Worktree" })).toHaveCount(0);
      } else await expect(page.getByRole("button", { name: /^Project:/ })).toBeVisible();
      await shot(page, `new-thread-${suffix}`);
      if (width < 480) await page.getByRole("button", { name: "Environment", exact: true }).click();
      const project = page.getByRole("button", { name: /^Project:/ });
      await project.click();
      await page.getByRole("menuitemradio", { name: "relay", exact: true }).click();
      await expect(project).toHaveAccessibleName("Project: relay");
      const worktree = page.getByRole("checkbox", { name: "Worktree" });
      await worktree.check();
      await page.getByRole("button", { name: /^Start from:/ }).click();
      await page.getByRole("option", { name: "origin/main" }).click();
      await expect(page.getByRole("button", { name: "Start from: origin/main" })).toBeVisible();
      await shot(page, `environment-${suffix}`);
      if (width < 480) {
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Back to threads" }).click();
      }
      await page.getByRole("button", { name: /^Project filter:/ }).click();
      await page.getByRole("menuitem", { name: "Actions for ace", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Rename ace…" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Remove ace…" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Open in…" })).toBeVisible();
      await shot(page, `project-actions-${suffix}`);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /, account$/ }).click();
      await expect(page.getByRole("menuitem", { name: "Archived threads" })).toBeVisible();
      await shot(page, `profile-${suffix}`);
      await page.getByRole("menuitem", { name: "Archived threads" }).click();
      await expect(page.getByRole("heading", { name: "Archived threads" })).toBeVisible();
    });
  }
for (const preset of ["midnight", "graphite", "paper", "slate", "contrast"])
  test(`setup and environment work at 390px in ${preset}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.addInitScript((id) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: id }));
    }, preset);
    await page.goto("/setup");
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page.getByRole("button", { name: "Add a project", exact: true })).toBeVisible();
    await shot(page, `setup-${preset}-390`);
    await page.goto("/new");
    await page.getByRole("button", { name: "Environment", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Project:/ })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Worktree" })).toBeChecked();
    await shot(page, `environment-${preset}-390`);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("button", { name: "Environment", exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Worktree" })).toBeChecked();
  });
