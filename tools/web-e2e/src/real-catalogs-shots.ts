import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const out = "/tmp/ace-orch/shots/fix-real-catalogs";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      await context.addInitScript((selectedTheme) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme }));
        Object.assign(globalThis, { aceFakeWorld: "real-catalogs" });
      }, theme);
      const page = await context.newPage();
      const visit = (path: string) => page.goto(`http://127.0.0.1:5259${path}`);
      const shot = async (name: string) => {
        await expect(page.locator("body")).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `${out}/${name}-${theme}-${width}.png`,
          animations: "disabled",
        });
        console.log(`${name}-${theme}-${width}`);
      };
      await visit("/settings/providers/opencode");
      await expect(page.getByText("No models enabled", { exact: true })).toBeVisible();
      await shot("provider-opencode");
      await page.getByRole("button", { name: /^Default model:/ }).click();
      await expect(page.getByRole("listbox", { name: "Models" })).toBeVisible();
      await expect(page.getByRole("option", { name: /Big Pickle/ })).toBeVisible();
      await shot("picker-opencode");
      await visit("/settings/providers/pi");
      await expect(page.getByText("ChatGPT / Codex", { exact: true }).first()).toBeVisible();
      await shot("provider-pi");
      await page.getByRole("button", { name: "Connect a service", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Sign in to Pi" })).toHaveCSS("opacity", "1");
      await expect(
        page.getByRole("button", { name: "ChatGPT / Codex", exact: true }),
      ).toContainText("Connected");
      await shot("pi-connect-service");
      await visit("/settings/providers/pi");
      await page.getByRole("button", { name: /^Default model:/ }).click();
      await expect(page.getByRole("group", { name: "Ollama Cloud", exact: true })).toBeVisible();
      await shot("picker-pi");
      await visit("/accounts");
      const table = page.getByRole("table", { name: "Usage by model" });
      await expect(
        table.getByRole("cell", { name: "Muse Spark 1.3 Contributor", exact: true }),
      ).toHaveCount(1);
      await table.scrollIntoViewIfNeeded();
      await shot("usage-models");
      await page
        .getByRole("heading", { name: "Usage & accounts", level: 2, exact: true })
        .scrollIntoViewIfNeeded();
      await shot("usage-accounts");
      await visit("/skills");
      await expect(page.getByRole("link", { name: /clerk/i }).first()).toBeVisible();
      await shot("skills");
      await visit("/t/thread-cold-start");
      const message = page.getByRole("combobox", { name: "Message" });
      await expect(message).toBeVisible();
      await message.fill("/");
      await expect(page.getByRole("option", { name: /clerk/i })).toBeVisible();
      await shot("slash-menu-claude");
      await visit("/t/thread-cold-start");
      await page
        .getByRole("button", { name: /^Model:/ })
        .first()
        .click();
      await page.getByRole("button", { name: /^Change model:/ }).click();
      await page.getByRole("tab", { name: "Favorites", exact: true }).click();
      await expect(page.getByRole("option", { name: /Opus 5.5/ })).toBeVisible();
      await shot("picker-favorites");
      await context.close();
    }
} finally {
  await browser.close();
}
