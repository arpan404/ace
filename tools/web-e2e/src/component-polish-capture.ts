import { expect, type Page } from "@playwright/test";
export const expectReady = expect.configure({ timeout: 15000 });
export interface ComponentCapture {
  page: Page;
  width: number;
  go(path: string): Promise<void>;
  capture(name: string, action: () => Promise<void>): Promise<void>;
}
/** Screenshots use a fresh fake world; errors keep a diagnostic image and don't stop independent captures. */
export function createCapture(
  page: Page,
  width: number,
  out: string,
  suffix: string,
  errors: string[],
): ComponentCapture {
  return {
    page,
    width,
    async go(path) {
      if (page.url().startsWith("http://127.0.0.1:5397"))
        await page.evaluate(() => localStorage.removeItem("ace.workspace"));
      await page.goto(`http://127.0.0.1:5397${path}`);
      await expectReady(page.locator("header h1").first()).toBeVisible();
      if (path.startsWith("/new"))
        await expectReady(
          page.getByRole("combobox", { name: "Message", exact: true }),
        ).toBeVisible();
      if (path.startsWith("/t/")) {
        await expectReady(page.getByRole("button", { name: /^Model:/ })).toBeVisible();
        await expectReady(page.getByRole("feed", { name: "Transcript" })).toBeVisible();
        await expectReady(
          page.getByRole("feed", { name: "Transcript" }).locator('[data-slot="skeleton"]'),
        ).toHaveCount(0);
      }
    },
    async capture(name, action) {
      try {
        await action();
        await expectReady(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
        await page.screenshot({ path: `${out}/${name}-${suffix}.png` });
        console.log(`${name}-${suffix}`);
      } catch (error) {
        console.warn(
          `Capture failed: ${name}-${suffix}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        );
        errors.push(
          `${name}-${suffix}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        );
        await page.screenshot({ path: `${out}/failed-${name}-${suffix}.png` });
      }
    },
  };
}
