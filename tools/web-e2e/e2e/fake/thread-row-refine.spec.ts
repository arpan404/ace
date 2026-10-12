import { expect, test } from "@playwright/test";
import { stageSidebarTasks } from "./sidebar-tasks.fixture.ts";
import { scrollToRow } from "./thread-list.ts";
import { screenThemes } from "../../src/appearance.ts";

const out = "/tmp/ace-orch/shots/ui-thread-row-refine";

for (const theme of screenThemes)
  for (const width of [1440, 390])
    test(`meta line and account chip in ${theme} at ${width}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await stageSidebarTasks(page, theme);
      await page.goto("/t/sidebar-1");
      const chip = page.getByRole("button", { name: /^Model: Opus 5.5, Personal/ });
      await expect(chip).toBeVisible();
      await expect(chip.getByRole("img", { name: "Claude Code · Personal" })).toBeVisible();
      await page.screenshot({
        path: `${out}/composer-${theme}-${width}.png`,
        animations: "disabled",
      });
      if (width === 390) await page.getByRole("button", { name: "Back to threads" }).click();
      const nav = page.getByRole("navigation", { name: "Threads" });
      const changed = nav.getByRole("link", { name: /^Audit Console/ });
      await expect(changed).toBeVisible();
      for (const interact of [() => changed.hover(), () => changed.focus()]) {
        await interact();
        await expect(changed).not.toHaveAccessibleName(/lines added|removed/);
        await expect(changed.getByText(/^\+3$|^−1$/)).toHaveCount(0);
      }
      const local = nav.getByRole("link", { name: /^greeting/ });
      await expect(local.getByRole("img", { name: "Claude Code", exact: true })).toBeVisible();
      await expect(local.getByText("Done", { exact: true })).toHaveCount(0);
      await expect(nav.getByRole("img", { name: /^Device:/ })).toHaveCount(0);
      for (const interact of [() => local.hover(), () => local.focus()]) {
        await interact();
        await expect(local.getByText(/· This Mac|· This machine/)).toHaveCount(0);
      }
      const remote = nav.getByRole("link", { name: /^Hi bro/ });
      await expect(remote).toHaveAccessibleName(/Running on Build server/);
      await remote.focus();
      const details = page.getByLabel("Details for Hi bro", { exact: true });
      await expect(details).toContainText("Build server");
      await expect(details).toContainText("GPT-5.5");
      await expect(nav.getByRole("img", { name: /^Device:/ })).toHaveCount(0);
      await page.screenshot({ path: `${out}/hover-${theme}-${width}.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await local.evaluate((element) => element.blur());
      await page.mouse.move(width - 2, 898);
      await page.screenshot({
        path: `${out}/sidebar-${theme}-${width}.png`,
        animations: "disabled",
      });
      const long = nav.getByRole("link", { name: /^independent browser-path/ });
      await scrollToRow(page, long);
      await long.hover();
      await expect(page.getByLabel(/^Details for independent browser-path/)).toContainText(
        "GPT-5.5",
      );
      expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    });
