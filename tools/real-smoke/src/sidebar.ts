import { expect, type Page } from "@playwright/test";

/** Walk mounted rows, then scroll the virtual list until the cap or its real end. */
export async function sidebarThreads(page: Page, cap: number) {
  const nav = page.getByRole("navigation", { name: "Threads", exact: true });
  await expect(nav).toBeVisible();
  const viewport = nav.locator("[data-virtual-viewport]").first();
  const seen = new Set<string>();
  for (let round = 0; round < cap + 10; round++) {
    const settled = nav.locator('[data-settled-toggle][aria-expanded="false"]');
    if (await settled.count()) await settled.click();
    const links = await nav
      .locator('a[href^="/t/"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? ""));
    for (const link of links) {
      if (seen.size === cap) return [...seen];
      if (link) seen.add(link);
    }
    const end = await viewport.evaluate(
      (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
    if (end) return [...seen];
    const previous = links.join("\n");
    await viewport.evaluate((element) => {
      element.scrollTop += element.clientHeight * 0.75;
    });
    await expect
      .poll(async () => {
        const mounted = await nav
          .locator('a[href^="/t/"]')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? ""));
        return (
          mounted.join("\n") !== previous ||
          (await viewport.evaluate(
            (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
          ))
        );
      })
      .toBe(true);
  }
  throw new Error("Sidebar traversal did not reach its end or thread cap");
}
