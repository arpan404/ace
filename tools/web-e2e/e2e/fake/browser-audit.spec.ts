import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const shots = "/tmp/ace-orch/shots/fix-audit-browser";
for (const theme of ["Light", "Dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} browser at ${width}px keeps notifications readable`, async ({ page }) => {
      test.setTimeout(60000);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.bringToFront();
      await mkdir(shots, { recursive: true });
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
        theme.toLowerCase(),
      );
      await page.goto("/t/thread-cold-start");
      await expect(
        page.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
      ).toBeVisible();
      await page.getByRole("combobox", { name: "Message", exact: true }).waitFor();
      await page.keyboard.press("Control+Shift+B");
      const panel = page.getByRole("region", { name: "Thread panel" });
      await expect(panel.getByRole("img", { name: /^Live view/ })).toBeVisible({ timeout: 30000 });
      await panel.getByRole("img", { name: /^Live view/ }).click();
      await page.screenshot({
        animations: "disabled",
        path: `${shots}/${theme.toLowerCase()}-${width}.png`,
      });
      const expand = panel.getByRole("button", { name: "Full view" });
      if (await expand.isVisible()) await expand.click();
      const hide = page.getByRole("button", { name: "Hide sidebar" });
      if (await hide.isVisible()) await hide.click();
      await panel.getByRole("button", { name: "Browser options" }).click();
      await page.getByRole("menuitem", { name: "Copy address" }).click();
      await expect(page.getByText("Address copied", { exact: true })).toBeVisible();
      const toast = page.getByText("Address copied", { exact: true });
      await toast.hover();
      const box = await toast.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.screenshot({
        animations: "disabled",
        path: `${shots}/${theme.toLowerCase()}-${width}-toast.png`,
      });
      const shrink = panel.getByRole("button", { name: "Exit full view" });
      if (await shrink.isVisible()) await shrink.click();
      await panel.getByRole("combobox", { name: "Address" }).focus();
      await page.keyboard.press("ControlOrMeta+t");
      await expect(panel.getByRole("tab", { name: /^localhost/ })).toHaveCount(1);
    });
  }
}
