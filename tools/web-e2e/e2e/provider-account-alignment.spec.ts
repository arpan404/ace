import { expect, test } from "@playwright/test";
import {
  expectProviderAccountGeometry,
  providerActionEdge,
} from "../src/provider-account-geometry.ts";

for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
  for (const width of [1440, 390])
    test(`account readings and hover actions end at Update in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((selected) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selected }));
        Object.assign(globalThis, { aceFakeWorld: "idle" });
      }, theme);
      await page.goto("/settings/providers/codex");
      await expect(page.getByRole("meter", { name: "5-hour window" })).toBeVisible();
      const edge = await providerActionEdge(page);
      await expectProviderAccountGeometry(page, edge);
      const personal = page
        .getByRole("listitem")
        .filter({ has: page.getByText("Personal", { exact: true }) });
      await personal.hover();
      await personal.getByRole("button", { name: "Make default", exact: true }).click();
      await expect(personal.getByText("Default", { exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(personal.getByText("38%", { exact: true })).toBeVisible();
      await expectProviderAccountGeometry(page, edge);
      for (const id of ["claude", "opencode", "cursor", "pi"]) {
        await page.goto(`/settings/providers/${encodeURIComponent(id)}`);
        await expect(
          page
            .getByRole("list", { name: / accounts$/ })
            .getByRole("img", { name: / account$/ })
            .first(),
        ).toBeVisible();
        await expectProviderAccountGeometry(page, edge);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
