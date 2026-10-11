import { expect, type Page } from "@playwright/test";

/** Real app controls against production CSS. Run after capturing performance measurements. */
export async function verifyPopoverToasts(page: Page): Promise<void> {
  const viewport = page.locator('[data-slot="toast-viewport"]');
  const visibility = () => viewport.evaluate((node) => getComputedStyle(node).visibility);
  await expect.poll(visibility).toBe("visible");
  await page.getByRole("button", { name: /^Model:/ }).click();
  const model = page.getByRole("dialog", { name: "Model and effort" });
  await expect(model).toBeVisible();
  await expect.poll(visibility).toBe("hidden");
  const changeModel = model.getByRole("button", { name: /^Change model:/ });
  if (await changeModel.count()) {
    await changeModel.click();
    await expect(model.getByRole("combobox", { name: "Search models" })).toBeVisible();
    await expect.poll(visibility).toBe("hidden");
  }
  await page.keyboard.press("Escape");
  await expect(model).not.toBeVisible();
  await expect.poll(visibility).toBe("visible");

  await page.setViewportSize({ width: 390, height: 900 });
  const more = page.getByRole("banner").getByRole("button", { name: "More actions" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const tools = page.getByRole("button", { name: "Work card", includeHidden: true });
  const overflow = page.locator('[data-slot="popover-content"]').filter({ has: tools });
  await expect(overflow).toBeVisible();
  await expect.poll(visibility).toBe("hidden");
  const popup = await overflow.elementHandle();
  if (!popup) throw new Error("The header overflow popup was missing");
  await page.keyboard.press("Escape");
  await expect(overflow).not.toBeVisible();
  await expect.poll(visibility).toBe("visible");
  expect(
    await popup.evaluate((node) => ({
      mounted: node.isConnected,
      open: node.hasAttribute("data-open"),
    })),
  ).toEqual({ mounted: true, open: false });
  await popup.dispose();
  console.log("  popover notification visibility, including closed mounted popup: passed");
}
