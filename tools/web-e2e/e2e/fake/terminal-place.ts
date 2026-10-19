import type { Page } from "@playwright/test";

/**
 * Terminals open in the side panel on this device (Settings › General › Terminals open in), as
 * a person who chose it earlier has them. Set once, before the app first reads its layout.
 */
export async function terminalsInSidePanel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!localStorage.getItem("ace.workspace"))
      localStorage.setItem(
        "ace.workspace",
        JSON.stringify({ preferred: { right: 520, place: "side" }, scopes: [] }),
      );
  });
}
