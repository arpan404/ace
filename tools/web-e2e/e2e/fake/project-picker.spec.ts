import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`project picker searches safely and device hover wins in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(
        (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
        theme,
      );
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/new?project=ace&fakeWorld=thread-activity");
      const message = page.getByRole("combobox", { name: "Message", exact: true });
      await expect(message).toBeVisible();
      await message.fill("Preserve this draft");
      await page.getByRole("button", { name: "Project: ace", exact: true }).click();
      const popup = page.getByRole("dialog", { name: "Choose project", exact: true });
      const search = popup.getByRole("combobox", { name: "Search projects", exact: true });
      await expect(search).toBeFocused();
      await search.fill("RELAY");
      await expect(popup.getByRole("option")).toHaveCount(1);
      await page.screenshot({
        path: `/tmp/ace-project-picker-popup-${theme}-${width}.png`,
        animations: "disabled",
      });
      await search.press("ArrowDown");
      await search.press("Enter");
      await expect(page.getByRole("button", { name: "Project: relay", exact: true })).toBeVisible();
      await expect(message).toHaveText("Preserve this draft");
      await page.getByRole("button", { name: "Project: relay", exact: true }).click();
      await search.fill("no-such-project");
      await expect(popup.getByText("No projects match.")).toBeVisible();
      await expect(popup.getByRole("button", { name: "Add project", exact: true })).toBeVisible();
      await search.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Project: relay", exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({
        path: `/tmp/ace-project-picker-${theme}-${width}.png`,
        animations: "disabled",
      });
      if (width === 1440) {
        const row = page.locator('[data-thread-row="thread-sheet-rotate"]');
        const device = row.getByRole("img", { name: /^Device:/ });
        await expect(device).toBeVisible();
        const label = ((await device.getAttribute("aria-label")) ?? "").slice("Device: ".length);
        await row.getByRole("link").hover();
        await expect(page.locator('[data-slot="hover-card-content"]')).toBeVisible();
        await device.hover();
        await expect(page.locator('[data-slot="hover-card-content"]')).toContainText(label);
        const provider = row.getByRole("img", { name: /^(Codex|Claude)/ });
        const deviceBox = await device.boundingBox();
        const providerBox = await provider.boundingBox();
        expect(deviceBox && providerBox && deviceBox.x + deviceBox.width <= providerBox.x).toBe(
          true,
        );
        await page.mouse.move(900, 10);
        await row.getByRole("link").focus();
        await expect(page.locator('[data-slot="hover-card-content"]')).toContainText(label);
        await expect(row.locator('[role="img"][tabindex="0"]')).toHaveCount(0);
        const local = page.locator('[data-thread-row="thread-replay-cursor"]');
        await expect(local.getByRole("img", { name: /^Device:/ })).toHaveCount(0);
        await local.getByRole("link").hover();
        await expect(page.locator('[data-slot="hover-card-content"]')).toContainText("This Mac");
        await expect(page.locator('[data-slot="hover-card-content"]')).toHaveCount(1);
        await page.screenshot({
          path: `/tmp/ace-thread-hover-${theme}.png`,
          animations: "disabled",
        });
        const deviceSvg = await device.locator("svg").boundingBox();
        const providerSvg = await provider.locator("svg").first().boundingBox();
        expect(deviceSvg?.width).toBe(14);
        expect(providerSvg?.width).toBe(14);
      }
      expect(errors).toEqual([]);
    });
