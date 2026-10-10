import { expect, test } from "@playwright/test";
import { expectBrandMark } from "../src/brand-mark-check.ts";

const providers = [
  ["Claude Code", "claude"],
  ["Codex", "openai"],
  ["OpenCode", "opencode"],
  ["Cursor", "cursor"],
  ["Pi", "pi"],
  ["Gemini CLI", "geminicli"],
] as const;

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`Usage loads visible brands, aligned readings and the thread sidebar in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((selected) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selected }));
        Object.assign(globalThis, {
          aceFakeWorld: "idle",
          aceFakeSetup: new Function(
            "daemon",
            `
          const account = daemon.services.accounts.find(row => row.id === 'claude-personal');
          account.quota.windows = { seven_day: account.quota.windows.seven_day };
        `,
          ),
        });
      }, theme);
      await page.goto("/accounts");
      await expect(page.getByRole("article", { name: "Codex Personal" })).toBeVisible();
      for (const row of await page.getByRole("article").all()) {
        const label = (await row.getAttribute("aria-label")) ?? "";
        const provider = providers.find(([name]) => label.startsWith(`${name} `));
        if (!provider) throw new Error(`Unknown provider in ${label}`);
        const account = label.slice(provider[0].length + 1);
        await expect(row.getByText(`${provider[0]} · ${account}`, { exact: true })).toBeVisible();
        await expect(
          row.getByRole("img", { name: `${account} account`, exact: true }),
        ).toBeVisible();
        await expectBrandMark(
          row.getByRole("img", { name: provider[0], exact: true }),
          provider[1],
          16,
        );
      }
      const box = async (locator: ReturnType<typeof page.getByRole>) => {
        const bounds = await locator.boundingBox();
        if (!bounds) throw new Error("Missing visible reading");
        return bounds;
      };
      const work = page.getByRole("article", { name: "Claude Code Work" });
      const personal = page.getByRole("article", { name: "Codex Personal" });
      const daily = page.getByRole("article", { name: "Gemini CLI Google" });
      for (const name of ["5-hour window", "Weekly window"]) {
        expect((await box(work.getByRole("meter", { name }))).x).toBe(
          (await box(personal.getByRole("meter", { name }))).x,
        );
      }
      const weeklyOnly = page.getByRole("article", { name: "Claude Code Personal" });
      await expect(weeklyOnly.getByRole("meter", { name: "5-hour window" })).toHaveCount(0);
      expect((await box(weeklyOnly.getByRole("meter", { name: "Weekly window" }))).x).toBe(
        (await box(work.getByRole("meter", { name: "Weekly window" }))).x,
      );
      expect((await box(daily.getByRole("meter", { name: "Daily window" }))).x).toBe(
        (await box(work.getByRole("meter", { name: "5-hour window" }))).x,
      );
      expect((await box(work.getByText(/^Resets/))).x).toBe(
        (await box(personal.getByText(/^Resets/))).x,
      );
      await expect(
        page
          .getByRole("article", { name: "Codex Team" })
          .getByText("Limit reached", { exact: true }),
      ).toBeVisible();
      if (width === 1440) {
        expect((await box(work.getByRole("meter", { name: "5-hour window" }))).y).toBe(
          (await box(work.getByRole("meter", { name: "Weekly window" }))).y,
        );
        expect((await box(work)).height).toBeLessThanOrEqual(36);
      }
      if (width === 390) {
        expect((await box(work.getByRole("meter", { name: "5-hour window" }))).y).toBeGreaterThan(
          (await box(work.getByText("Claude Code · Work"))).y,
        );
        await page.getByRole("button", { name: "Back to threads" }).click();
      }
      await expect(
        page.getByText("Dedupe thread events after reconnect", { exact: true }).first(),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
