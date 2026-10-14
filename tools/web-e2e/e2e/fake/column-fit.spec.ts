import { expect, test, type Page } from "@playwright/test";

/*
 * Everything inside the thread column fits that column at every window width: controls shape
 * themselves by the column's width (container queries, a measured width), never the window's.
 */

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

/** Interactive elements in the thread column that cross its edges, by name. */
async function overflowing(page: Page): Promise<string[]> {
  return page.locator("[data-thread-column]").evaluate((column) => {
    const edge = column.getBoundingClientRect();
    const crossing: string[] = [];
    for (const element of column.querySelectorAll<HTMLElement>(
      "button, a, input, [role=combobox], [role=status], [role=tab]",
    )) {
      const box = element.getBoundingClientRect();
      if (!box.width || !element.checkVisibility()) continue;
      // Content a horizontal scroller (a code block, a diff) moves into view is not overflow.
      let scrolled = false;
      for (let parent = element.parentElement; parent && parent !== column;) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowX)) scrolled = true;
        parent = parent.parentElement;
      }
      if (scrolled) continue;
      if (box.left < edge.left - 1 || box.right > edge.right + 1)
        crossing.push((element.getAttribute("aria-label") ?? element.textContent ?? "").trim());
    }
    return crossing;
  });
}

async function openPanel(page: Page) {
  const panel = page.getByRole("region", { name: "Thread panel" });
  if (await panel.isVisible()) return;
  await page.getByRole("banner").getByRole("button", { name: "Right panel" }).click();
  await expect(panel).toBeVisible();
}

for (const viewport of viewports) {
  test(`the thread, its subagent bar and the composer fit their column at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/t/thread-dedupe");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    expect(await overflowing(page)).toEqual([]);

    await page.goto("/t/thread-resumable-streams/agents/thread-resumable-streams.agent.6");
    const bar = page.getByRole("group", { name: "Subagent" });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("link", { name: "Open parent" })).toBeVisible();
    expect(await overflowing(page)).toEqual([]);
  });
}

for (const viewport of viewports.slice(0, 3))
  test(`approvals stay in reach beside an open side panel at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/t/thread-replay-cursor");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    await openPanel(page);
    // Where the panel floats over the column (a modal sheet) the composer behind it still keeps
    // its approvals on show rather than folding into the pill.
    await expect(
      page.locator('[data-slot="composer"] button[aria-label^="Access: "]'),
    ).toBeVisible();
    expect(await overflowing(page)).toEqual([]);
  });
