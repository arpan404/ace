import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Computer use and browser parity against the fake daemon's computer-use world, in every theme,
 * to /tmp/aceshots-cuaui/<screen>-<theme>.png. Pictures inside live views are fixtures, never a
 * real screen. Run on demand: `bunx playwright test --project=screens computer-use-screens`.
 */
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-cuaui";
mkdirSync(out, { recursive: true });

// Dark and Light by default; ACE_SHOT_THEMES=light,dark,midnight,graphite,paper,slate,contrast
// shoots every preset.
const themes = (process.env.ACE_SHOT_THEMES ?? "dark,light").split(",").filter(Boolean);

type Setup = (page: Page) => Promise<void>;
const panel = (page: Page) => page.getByRole("region", { name: "Thread panel" });

async function openTool(page: Page, path: string, tool: string | RegExp) {
  await page.goto(path);
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  const region = panel(page);
  if (!(await region.isVisible())) await page.getByRole("button", { name: "Right panel" }).click();
  const existing = region.getByRole("tab", { name: tool });
  if (await existing.count()) return existing.first().click();
  await region.getByRole("button", { name: "New tab" }).click();
  await region
    .getByRole("list", { name: "Tools" })
    .getByRole("button", { name: typeof tool === "string" ? new RegExp(`^${tool}`) : tool })
    .click();
}

const screens: Record<string, Setup> = {
  "settings-computer-use": async (page) => {
    await page.goto("/settings/computer-use");
    await expect(page.getByRole("heading", { name: "Computer use", level: 2 })).toBeVisible();
    await expect(page.getByRole("article", { name: "TextEdit" })).toBeVisible();
  },
  "thread-computer-use-panel": async (page) => {
    await openTool(page, "/t/thread-cold-start", "Computer use");
    await expect(panel(page).getByRole("article", { name: "TextEdit" })).toBeVisible();
  },
  "rail-indicator": async (page) => {
    await page.goto("/t/thread-cold-start");
    const indicator = page.getByRole("button", { name: /Agents are using/ });
    await indicator.click({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Stop / }).first()).toBeVisible();
  },
  "approval-app-request": async (page) => {
    await page.goto("/t/thread-dedupe");
    await expect(page.getByRole("article", { name: "Let an agent use Notes" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("article", { name: "Let an agent use Notes" }).scrollIntoViewIfNeeded();
  },
  "activity-app-request": async (page) => {
    await page.goto("/activity");
    await expect(page.getByRole("article", { name: "Let an agent use Notes" })).toBeVisible({
      timeout: 15_000,
    });
  },
  "browser-tabs-dialog": async (page) => {
    await openTool(page, "/t/thread-cold-start", /^Browser|^localhost|^status/);
    await expect(panel(page).getByRole("tablist", { name: "Agent tabs" })).toBeVisible();
    await expect(panel(page).getByRole("alertdialog")).toBeVisible();
  },
  "browser-downloads": async (page) => {
    await openTool(page, "/t/thread-cold-start", /^Browser|^localhost|^status/);
    await panel(page)
      .getByRole("button", { name: /^Downloads/ })
      .click();
    await expect(page.getByRole("list", { name: "Downloads" })).toBeVisible();
  },
  "browser-site-access": async (page) => {
    await openTool(page, "/t/thread-cold-start", /^Browser|^localhost|^status/);
    await panel(page).getByRole("button", { name: "Site access" }).click();
    await expect(page.getByRole("region", { name: "Read-only scripts" })).toBeVisible();
  },
  "browser-private": async (page) => {
    await openTool(page, "/t/thread-cold-start", /^Browser|^localhost|^status/);
    // Answer the page first: a pending question holds every other command.
    await panel(page).getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await panel(page).getByRole("button", { name: "Make private", exact: true }).click();
    // Private: the toggle is gone and the pill offers only Hand back.
    await expect(panel(page).getByRole("button", { name: "Make private" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "Hand back", exact: true })).toBeVisible();
  },
  "devices-delegated": async (page) => {
    await openTool(page, "/t/thread-install-page", "Devices");
    const region = panel(page);
    await region.getByRole("button", { name: "Enable devices" }).click();
    await region
      .getByRole("list", { name: "Devices" })
      .getByRole("button", { name: /^iPhone/ })
      .click();
    const device = region.getByRole("region", { name: /^iPhone/ });
    await device.getByRole("button", { name: "Approve" }).click();
    await device.getByRole("button", { name: "Delegate to an agent" }).click();
    await page.getByRole("menuitem").first().click();
    await expect(device.getByText(/is using it$/)).toBeVisible();
  },
};

for (const theme of themes)
  for (const [name, setup] of Object.entries(screens))
    test(`${name} in ${theme}`, async ({ page }) => {
      test.skip(
        process.env.ACE_SHOT_SCREENS !== undefined &&
          !process.env.ACE_SHOT_SCREENS.split(",").includes(name),
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript((id) => {
        Object.assign(globalThis, { aceFakeWorld: "computer-use" });
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: id }));
      }, theme);
      await setup(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${name}-${theme}.png` });
    });
