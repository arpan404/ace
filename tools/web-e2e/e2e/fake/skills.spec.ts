import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const out = process.env.ACE_SHOTS_DIR;
if (out) mkdirSync(out, { recursive: true });

for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
  for (const width of [1440, 390])
    test(`skills stay readable and usable in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (id) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: id })),
        theme,
      );
      await page.goto("/skills/engineering~skill~code-review");
      await expect(page.getByRole("heading", { level: 1, name: "Code review" })).toBeVisible();
      const preview = page.getByRole("region", { name: "Preview" });
      await expect(preview.getByRole("heading", { name: "code-review" })).toBeVisible();
      const control = page.getByRole("switch", { name: "Enabled" });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.width).toBeLessThanOrEqual(40);
      expect(box?.x).toBeGreaterThan(width / 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      if (width === 1440) {
        const list = page.getByRole("navigation", { name: "Skills catalog" });
        for (const row of await list.getByRole("link").all()) {
          const rowBox = await row.boundingBox();
          expect(rowBox?.height).toBeGreaterThanOrEqual(32);
          expect(rowBox?.height).toBeLessThanOrEqual(36);
        }
      }
      if (out && ["light", "dark"].includes(theme))
        await page.screenshot({
          animations: "disabled",
          path: `${out}/skill-${theme}-${width}.png`,
        });
      await page.getByRole("link", { name: "Use in a thread" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Message" })).toHaveValue("/code-review ");
      await expect(page.getByRole("button", { name: /^Project:/ })).toBeVisible();
      for (const toast of await page.getByRole("button", { name: "Dismiss", exact: true }).all())
        await toast.click();
      if (out && ["light", "dark"].includes(theme))
        await page.screenshot({
          animations: "disabled",
          path: `${out}/skill-draft-${theme}-${width}.png`,
        });
      await page.goto("/skills/engineering~skill~code-review");
      await expect(control).toBeChecked();
      await control.click();
      await expect(control).not.toBeChecked();
      await control.click();
      await expect(control).toBeChecked();
      await page.goto("/skills/plugin~engineering");
      await expect(page.getByRole("heading", { level: 1, name: "Engineering" })).toBeVisible();
      const pluginSwitch = page.getByRole("switch", { name: "Enabled" });
      expect((await pluginSwitch.boundingBox())?.width).toBeLessThanOrEqual(40);
      const contents = page.getByRole("region", { name: "Contents" });
      await expect(contents.getByRole("link", { name: "Test-driven development" })).toBeVisible();
      for (const row of await contents.getByRole("link").all())
        expect((await row.boundingBox())?.height).toBeLessThanOrEqual(36);
      if (out && ["light", "dark"].includes(theme))
        await page.screenshot({
          animations: "disabled",
          path: `${out}/plugin-${theme}-${width}.png`,
        });
    });
