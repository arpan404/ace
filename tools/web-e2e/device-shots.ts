import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const output = "/tmp/ace-orch/shots/ui-devices-computer-use";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(
        (selectedTheme) =>
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme })),
        theme,
      );
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:5197/t/thread-dedupe");
      await page.getByRole("feed", { name: "Transcript" }).waitFor();
      await page.keyboard.press("Control+Shift+m");
      const panel = page.getByRole("region", { name: "Thread panel" });
      await panel.getByRole("button", { name: "Enable devices" }).click();
      await panel
        .getByRole("list", { name: "Devices" })
        .getByRole("button", { name: /^iPhone 16 Pro/ })
        .click();
      const device = panel.getByRole("region", { name: "iPhone 16 Pro" });
      await device.getByRole("button", { name: "Approve", exact: true }).click();
      await device.getByRole("img", { name: "iPhone 16 Pro screen" }).waitFor();
      await device.getByRole("button", { name: "Device actions" }).click();
      await page.getByRole("menuitem", { name: "Device settings…" }).waitFor();
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      if (theme === "light" || theme === "dark")
        await page.screenshot({
          animations: "disabled",
          path: `${output}/devices-${theme}-${width}.png`,
        });
      await page.getByRole("menuitem", { name: "Device settings…" }).click();
      await page.getByRole("dialog", { name: "Device settings" }).waitFor();
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      if (theme === "light" || theme === "dark")
        await page.screenshot({
          animations: "disabled",
          path: `${output}/device-settings-${theme}-${width}.png`,
        });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await panel.getByRole("button", { name: "New tab" }).click();
      await panel
        .getByRole("list", { name: "Tools" })
        .getByRole("button", { name: /^Computer use/ })
        .click();
      await panel.getByRole("button", { name: "Share an app or window…" }).click();
      await page.getByRole("button", { name: "TextEdit · Untitled", exact: true }).waitFor();
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      if (theme === "light" || theme === "dark")
        await page.screenshot({
          animations: "disabled",
          path: `${output}/share-${theme}-${width}.png`,
        });
      const bounds = await page
        .getByRole("dialog", { name: "Share an app or window" })
        .boundingBox();
      if (!bounds || bounds.x < 0 || bounds.x + bounds.width > width)
        throw new Error(`Picker overflow in ${theme} at ${width}`);
      await page.getByRole("button", { name: "TextEdit · Untitled", exact: true }).click();
      if (!(await page.getByRole("button", { name: "Share with agent", exact: true }).isEnabled()))
        throw new Error(`Selection failed in ${theme}`);
      await context.close();
    }
} finally {
  await browser.close();
}
