import { expect, type Page } from "@playwright/test";

/** Assert actual layout, including scroll position after keyboard, menu and resize changes. */
export async function expectActiveTabVisible(page: Page) {
  const strip = page.getByRole("tablist", { name: "Thread panel tabs" });
  const active = strip.getByRole("tab", { selected: true });
  await expect
    .poll(async () => {
      const [row, tab] = await Promise.all([strip.boundingBox(), active.boundingBox()]);
      return !!row && !!tab && tab.x >= row.x - 1 && tab.x + tab.width <= row.x + row.width + 1;
    })
    .toBe(true);
}

export async function launchTool(page: Page, tool: string) {
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page
    .getByRole("list", { name: "Tools", exact: true })
    .getByRole("button", { name: new RegExp(`^${tool}(?: |$)`) })
    .click();
}

/** A single identifier must occupy one visual line, including when soft wrap is enabled. */
export async function expectIdentifierIntact(page: Page, identifier: string) {
  await expect
    .poll(() =>
      page.getByRole("tabpanel", { name: "Changes", exact: true }).evaluate((panel, word) => {
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.textContent?.indexOf(word) ?? -1;
          if (start < 0 || !node.parentElement?.closest("[data-line]")) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + word.length);
          const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
          return (
            rects.length > 0 &&
            rects.every((rect) => Math.abs(rect.top - (rects[0]?.top ?? rect.top)) < 1)
          );
        }
        return false;
      }, identifier),
    )
    .toBe(true);
}

export async function expectIndependentSplitScroll(page: Page) {
  const before = page.locator('[data-diff-side="old"]').first();
  const after = page.locator('[data-diff-side="new"]').first();
  await expect
    .poll(() => before.evaluate((node) => node.scrollWidth > node.clientWidth))
    .toBe(true);
  await expect.poll(() => after.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await before.evaluate((node) => {
    node.scrollLeft = 80;
  });
  expect(await before.evaluate((node) => node.scrollLeft)).toBe(80);
  expect(await after.evaluate((node) => node.scrollLeft)).toBe(0);
  await after.evaluate((node) => {
    node.scrollLeft = 120;
  });
  expect(await after.evaluate((node) => node.scrollLeft)).toBe(120);
  expect(await before.evaluate((node) => node.scrollLeft)).toBe(80);
}

export async function expectDefaultDiffNoWrap(page: Page) {
  const line = page
    .getByRole("tabpanel", { name: "Changes", exact: true })
    .locator("[data-line]")
    .first();
  await expect.poll(() => line.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe("pre");
}
