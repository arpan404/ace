import { expect, test, type Locator } from "@playwright/test";

/** The alpha of a computed colour: `rgba(…, a)`, `color(srgb … / a)`, or 1 when opaque. */
const alphaOf = (colour: string) => {
  const match = /(?:,|\/)\s*([\d.]+)\s*\)$/.exec(colour);
  return match ? Number(match[1]) : 1;
};

async function glassOf(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, filter: style.backdropFilter };
  });
}

/*
 * Modal panels (search, the palette, dialogs) must read as a solid surface on every engine:
 * Chromium is the liquid-glass engine, whose thinner floating tint must never win over the modal
 * tint. The blur belongs to the backdrop behind them, once.
 */
for (const mode of ["light", "dark"])
  test(`search and the palette are dense glass over a blurred page on the liquid engine in ${mode}`, async ({
    page,
  }) => {
    await page.addInitScript((chosen) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ mode: chosen }));
    }, mode);
    await page.goto("/t/thread-refund-tax");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-glass-engine", "liquid");
    // A busy underlay: if the panel let it through, its colours would read behind the text.
    await page.locator("[data-thread-column]").evaluate((element) => {
      element.style.backgroundImage =
        "repeating-linear-gradient(45deg, #4777cb 0 6px, #ca7d53 6px 14px)";
    });
    const overlay = page.locator('[data-slot="dialog-overlay"]');

    await page.keyboard.press("ControlOrMeta+Shift+K");
    const search = page.getByRole("dialog", { name: "Search", exact: true });
    await expect(page.getByRole("combobox", { name: "Search every thread" })).toBeFocused();
    await expect(async () => {
      const panel = await glassOf(search);
      expect(panel.filter).toBe("none");
      expect(alphaOf(panel.background)).toBeGreaterThanOrEqual(0.9);
      const behind = await glassOf(overlay);
      expect(behind.filter).toContain("blur(16px)");
      expect(alphaOf(behind.background)).toBeLessThanOrEqual(0.2);
    }).toPass();
    await page.screenshot({ animations: "disabled", path: `/tmp/ace-search-glass-${mode}.png` });
    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();

    await page.keyboard.press("ControlOrMeta+K");
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    await expect(async () => {
      const panel = await glassOf(palette);
      expect(panel.filter).toBe("none");
      expect(alphaOf(panel.background)).toBeGreaterThanOrEqual(0.9);
    }).toPass();
    await page.keyboard.press("Escape");

    // The OS asking for less transparency turns the backdrop into a plain scrim.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await expect(page.locator("html")).toHaveAttribute("data-surface", "solid");
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await expect(async () => {
      const panel = await glassOf(search);
      expect(panel.filter).toBe("none");
      expect(alphaOf(panel.background)).toBe(1);
      expect((await glassOf(overlay)).filter).toBe("none");
    }).toPass();
  });
