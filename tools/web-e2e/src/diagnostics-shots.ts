import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/ace-orch/shots/feat-diagnostics-plugin-edit";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(
        (selectedTheme) =>
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme })),
        theme,
      );
      const page = await context.newPage();
      const shot = async (name: string) => {
        await page.screenshot({
          path: `${out}/${name}-${theme}-${width}.png`,
          animations: "disabled",
        });
        console.log(`${name}-${theme}-${width}`);
      };
      await page.goto("http://127.0.0.1:5237/settings/advanced");
      await page.getByRole("button", { name: "Run checks" }).click();
      await expect(page.getByRole("list", { name: "Check results" })).toBeVisible();
      await shot("checks");
      await page.getByRole("button", { name: "Export support bundle…" }).click();
      await expect(page.getByRole("dialog", { name: "Export support bundle" })).toHaveCSS(
        "opacity",
        "1",
      );
      await shot("export");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.goto("http://127.0.0.1:5237/skills/engineering~skill~code-review");
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Source text" })).toBeVisible();
      await shot("source-edit");
      await page
        .getByRole("textbox", { name: "Source text" })
        .fill("# code-review\n\nReview the changes and explain any remaining risks.");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
      await expect(page.getByRole("button", { name: "Accept changes" })).toBeVisible();
      await shot("source-review");
      await page.goto("http://127.0.0.1:5237/setup");
      await page.getByRole("region", { name: "Computer tools" }).scrollIntoViewIfNeeded();
      await expect(page.getByText(/Install Xcode from the App Store/)).toBeVisible();
      await shot("setup-tools");
      await page.goto("http://127.0.0.1:5237/t/thread-cold-start");
      await expect(page.getByRole("feed", { name: "Transcript" })).toBeVisible();
      await page.keyboard.press("Control+Shift+m");
      await expect(page.getByRole("button", { name: "Enable devices" })).toBeVisible();
      await shot("devices-tools");
      await page.keyboard.press("Control+Shift+l");
      // Logs initially shows the selected provider; select the app log from its scope menu.
      const panel = page.getByRole("region", { name: "Thread panel" });
      await expect(panel.getByRole("tab", { name: "Logs", selected: true })).toBeVisible();
      await panel.getByRole("button", { name: /^Log source:/ }).click();
      await page.getByRole("menuitemradio", { name: "App", exact: true }).click();
      await expect(panel.getByText(/Run checks or export a support bundle/)).toBeVisible();
      await shot("logs");
      await context.close();
    }
  for (const theme of ["midnight", "graphite", "paper", "slate", "contrast"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      (selectedTheme) =>
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme })),
      theme,
    );
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5237/settings/advanced");
    await page.getByRole("button", { name: "Run checks" }).click();
    await expect(page.getByRole("list", { name: "Check results" })).toBeVisible();
    await page.screenshot({ path: `${out}/checks-${theme}-390.png`, animations: "disabled" });
    await context.close();
  }
} finally {
  await browser.close();
}
