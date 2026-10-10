import { expect, test } from "@playwright/test";
for (const theme of ["light", "dark"])
  test(`rich thread preview keeps clean quick actions visible in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.addInitScript(
      (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
      theme,
    );
    await page.goto("/?fakeWorld=thread-activity");
    const row = page.locator('[data-thread-row="thread-refund-tax"]');
    await row.hover();
    await expect(page.getByLabel(/^Details for Partial refunds/)).toBeVisible();
    const settle = row.getByRole("button", { name: /^Settle / });
    const snooze = row.getByRole("button", { name: /^Snooze / });
    await expect(settle).toBeVisible();
    await expect(snooze).toBeVisible();
    expect(await settle.evaluate((node) => getComputedStyle(node).visibility)).toBe("visible");
    await snooze.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(snooze).toBeFocused();
    await row.click({ button: "right" });
    await expect(row).toHaveAttribute("data-row-menu-open", "");
    await expect(settle).toBeHidden();
    await page.keyboard.press("Escape");
    await row.hover();
    await expect(settle).toBeVisible();
    await page.screenshot({ path: `/tmp/ace-row-actions-${theme}.png` });
  });
