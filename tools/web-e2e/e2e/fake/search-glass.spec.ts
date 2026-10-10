import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"])
  test(`Search keeps a coloured underlay visible and honors transparency preferences in ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript((chosen) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen }));
    }, theme);
    await page.goto("/t/thread-refund-tax");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    // A controlled optical underlay makes colour diffusion visible in the screenshot.
    await page.locator("[data-thread-column]").evaluate((element) => {
      element.style.backgroundImage =
        "linear-gradient(110deg, transparent 15%, #4777cb 40%, #ca7d53 65%, transparent 85%)";
    });
    await page.keyboard.press("Meta+Shift+K");
    const search = page.getByRole("dialog", { name: "Search", exact: true });
    await expect(page.getByRole("combobox", { name: "Search every thread" })).toBeFocused();
    await expect(async () => {
      const style = await search.evaluate((element) => {
        const current = getComputedStyle(element);
        return { background: current.backgroundColor, filter: current.backdropFilter };
      });
      expect(style.background).toMatch(/rgba\(.+, 0\.\d+\)/);
      expect(style.filter).toContain("blur(24px)");
      expect(style.filter).toContain("saturate(1.5)");
      const dimmer = await page
        .locator('[data-slot="dialog-overlay"]')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(dimmer).toBe("rgba(0, 0, 0, 0.15)");
    }).toPass();
    await page.screenshot({
      animations: "disabled",
      path: `/tmp/ace-search-glass-underlay-${theme}.png`,
    });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await expect(async () => {
      const style = await search.evaluate((element) => {
        const current = getComputedStyle(element);
        return { background: current.backgroundColor, filter: current.backdropFilter };
      });
      expect(style.background).toMatch(/^rgb\(/);
      expect(style.filter).toBe("none");
    }).toPass();
    await session.send("Emulation.setEmulatedMedia", { features: [] });
    await page.evaluate(() => document.documentElement.style.setProperty("--glass", "0"));
    await expect(async () => {
      expect(await search.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(
        /^rgb\(/,
      );
      expect(
        await search.evaluate((element) => getComputedStyle(element).backdropFilter),
      ).toContain("blur(0px)");
    }).toPass();
  });
