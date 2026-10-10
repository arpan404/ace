import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectBrandMark } from "../src/brand-mark-check.ts";

const screenshots = "/tmp/ace-orch/shots/ui-providers-clean/followup";
mkdirSync(screenshots, { recursive: true });
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];

const providers = [
  { name: "Claude Code", id: "claude", brand: "claude" },
  { name: "Codex", id: "codex", brand: "openai" },
  { name: "OpenCode", id: "opencode", brand: "opencode" },
  { name: "Cursor", id: "cursor", brand: "cursor" },
  { name: "Pi", id: "pi", brand: "pi" },
  { name: "Antigravity", id: "antigravity", brand: "antigravity" },
  { name: "Gemini CLI", id: "acp:Gemini CLI", brand: "geminicli" },
] as const;

for (const theme of ["light", "dark"])
  test(`known providers show the real colour brand asset in ${theme} on every management screen`, async ({
    page,
  }) => {
    await page.addInitScript((chosen) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen }));
      Object.assign(globalThis, { aceFakeWorld: "empty" });
    }, theme);
    await page.goto("/settings/providers");
    for (const provider of providers) {
      const row = page.getByRole("group", { name: provider.name, exact: true });
      await expectBrandMark(
        row.getByRole("img", { name: provider.name, exact: true }),
        provider.brand,
        16,
      );
      await row.getByRole("link", { name: provider.name, exact: true }).click();
      await expectBrandMark(
        page.getByRole("main").getByRole("img", { name: provider.name, exact: true }).first(),
        provider.brand,
        24,
      );
      if (!["antigravity", "acp:Gemini CLI"].includes(provider.id)) {
        await page.getByRole("button", { name: "+ Add account", exact: true }).click();
        const dialog = page.getByRole("dialog", {
          name: new RegExp(`Add (a|an) ${provider.name} account`),
        });
        await expect(dialog).toBeVisible();
        await expectBrandMark(dialog.locator("svg").first(), provider.brand, 20);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
      await page.getByRole("link", { name: "Back to Providers" }).click();
    }
    await page.goto("/accounts");
    await expect(page.getByRole("article", { name: "Codex Personal" })).toBeVisible();
    for (const row of await page.getByRole("article").all()) {
      const label = (await row.getAttribute("aria-label")) ?? "";
      const provider = providers.find((candidate) => label.startsWith(`${candidate.name} `));
      if (!provider) throw new Error(`Unrecognized Usage row: ${label}`);
      const account = label.slice(provider.name.length + 1);
      await expect(row.getByText(`${provider.name} · ${account}`, { exact: true })).toBeVisible();
      await expect(row.getByRole("img", { name: `${account} account`, exact: true })).toBeVisible();
      await expectBrandMark(
        row.getByRole("img", { name: provider.name, exact: true }),
        provider.brand,
        16,
      );
    }
  });

for (const theme of themes)
  for (const width of [1440, 390])
    test(`${theme}: at ${width}px a CLI login can be renamed with the keyboard and its chosen badge follows every view`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme }));
        Object.assign(globalThis, {
          aceFakeWorld: "idle",
          aceFakeSetup: new Function(
            "daemon",
            `
          daemon.services.models.push(...daemon.services.models
            .filter(model => model.instance === 'claude-personal')
            .map(model => ({...model, instance:'claude-cli-default'})));
        `,
          ),
        });
        localStorage.setItem(
          "ace.home.newThread",
          JSON.stringify({ project: "ace", account: "claude-cli-default" }),
        );
      }, theme);
      await page.goto("/settings/providers/claude");
      const accounts = page.getByRole("list", { name: "Claude Code accounts" });
      const menu = accounts.getByRole("button", { name: "Manage Your CLI login" });
      await menu.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Rename", exact: true }).focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "Change badge" })).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      const editor = page.getByRole("dialog", { name: "Edit Your CLI login" });
      await expect(editor.getByRole("textbox", { name: "Account name" })).toBeFocused();
      await editor.getByRole("textbox", { name: "Account name" }).fill("Studio");
      await page.keyboard.press("Enter");
      await expect(editor).toHaveCount(0);
      await expect(accounts.getByRole("button", { name: "Manage Studio" })).toBeFocused();
      await expect(accounts.getByRole("img", { name: "Studio account" })).toHaveText("S");
      await accounts.getByRole("button", { name: "Manage Studio" }).click();
      await page.getByRole("menuitem", { name: "Change badge" }).click();
      const badgeEditor = page.getByRole("dialog", { name: "Edit Studio" });
      await badgeEditor.getByRole("button", { name: "Use violet badge" }).click();
      await badgeEditor.getByRole("button", { name: "Use 🧪 badge" }).click();
      await badgeEditor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(badgeEditor).toHaveCount(0);
      const check = async (badge: ReturnType<typeof page.getByRole>) => {
        await expect(badge).toHaveText("🧪");
        await expect
          .poll(() => badge.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe(
            await page.evaluate(() => {
              const span = document.createElement("span");
              span.style.backgroundColor = "var(--project-10)";
              document.body.append(span);
              const color = getComputedStyle(span).backgroundColor;
              span.remove();
              return color;
            }),
          );
      };
      await check(accounts.getByRole("img", { name: "Studio account" }));
      await expect(accounts.getByText("Default", { exact: true })).toBeVisible();
      await expect(accounts.getByText("/Users/ada/.claude", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Back to Providers" }).click();
      const stack = page
        .getByRole("group", { name: "Claude Code", exact: true })
        .getByRole("img", { name: "Studio account" });
      await check(stack);
      await stack.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(stack).toBeFocused();
      await expect(page.getByRole("tooltip", { name: "Studio", exact: true })).toBeVisible();
      await page.keyboard.press("ControlOrMeta+Alt+n");
      await expect(page.getByRole("button", { name: /^Model:/ })).toBeVisible();
      const profile = page.getByRole("button", { name: /, account$/ });
      if (!(await profile.isVisible()))
        await page.getByRole("button", { name: "Back to threads" }).click();
      await profile.click();
      await page.getByRole("menuitem", { name: "Usage", exact: true }).click();
      await check(
        page
          .getByRole("article", { name: "Claude Code Studio" })
          .getByRole("img", { name: "Studio account" }),
      );
      await page.keyboard.press("ControlOrMeta+Alt+n");
      await page.getByRole("button", { name: /^Model:/ }).click();
      const picker = page.getByRole("dialog", { name: "Model and effort" });
      const change = picker.getByRole("button", { name: /^Change model/ });
      if (await change.count()) await change.click();
      const source = picker.getByRole("tab", { name: "Claude Code · Studio" });
      await check(source.getByRole("img", { name: "Studio account" }));
      await source.click();
      await page.screenshot({
        path: `${screenshots}/picker-badge-${theme}-${width}.png`,
        animations: "disabled",
      });
      await picker
        .getByRole("option", { name: /^Opus 5.5/ })
        .first()
        .click();
      const chip = page.getByRole("button", { name: /^Model: Opus 5.5, Studio/ });
      await expect(chip.getByRole("img", { name: "Studio account" })).toHaveText("🧪");
      await expect
        .poll(() =>
          chip
            .getByRole("img", { name: "Studio account" })
            .evaluate((element) => getComputedStyle(element).color),
        )
        .toBe(
          await page.evaluate(() => {
            const probe = document.createElement("span");
            probe.style.color = "var(--project-10)";
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          }),
        );
      await page.screenshot({
        path: `${screenshots}/composer-badge-${theme}-${width}.png`,
        animations: "disabled",
      });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    });

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`default CLI initials are neutral and visible on every surface in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme }));
        localStorage.setItem(
          "ace.home.newThread",
          JSON.stringify({ project: "ace", account: "claude-cli-default" }),
        );
        Object.assign(globalThis, {
          aceFakeWorld: "idle",
          aceFakeSetup: new Function(
            "daemon",
            `daemon.services.models.push(...daemon.services.models.filter(model => model.instance === 'claude-personal').map(model => ({...model, instance:'claude-cli-default'})));`,
          ),
        });
      }, theme);
      const neutral = async (badge: ReturnType<typeof page.getByRole>) => {
        await expect(badge).toHaveText("Y");
        const ink = await page.evaluate(() => getComputedStyle(document.body).color);
        await expect
          .poll(() => badge.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe(ink);
      };
      await page.goto("/settings/providers/claude");
      await neutral(
        page
          .getByRole("list", { name: "Claude Code accounts" })
          .getByRole("img", { name: "Your CLI login account" }),
      );
      await page.goto("/settings/providers");
      await neutral(
        page
          .getByRole("group", { name: "Claude Code", exact: true })
          .getByRole("img", { name: "Your CLI login account" }),
      );
      await page.goto("/accounts");
      await neutral(
        page
          .getByRole("article", { name: "Claude Code Your CLI login" })
          .getByRole("img", { name: "Your CLI login account" }),
      );
      await page.goto("/new");
      const chip = page.getByRole("button", { name: /^Model:.*Your CLI login/ });
      await expect(chip.getByRole("img", { name: "Your CLI login account" })).toHaveText("Y");
      await page.screenshot({
        path: `${screenshots}/composer-initial-${theme}-${width}.png`,
        animations: "disabled",
      });
      await chip.click();
      const picker = page.getByRole("dialog", { name: "Model and effort" });
      const change = picker.getByRole("button", { name: /^Change model/ });
      if (await change.count()) await change.click();
      await neutral(
        picker
          .getByRole("tab", { name: "Claude Code · Your CLI login" })
          .getByRole("img", { name: "Your CLI login account" }),
      );
      await page.screenshot({
        path: `${screenshots}/picker-initial-${theme}-${width}.png`,
        animations: "disabled",
      });
    });
