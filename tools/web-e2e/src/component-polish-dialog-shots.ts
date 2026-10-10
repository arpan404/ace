import { chromium, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const out = "/tmp/ace-orch/shots/ui-polish-components";
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const browser = await chromium.launch();
const errors: string[] = [];
await mkdir(out, { recursive: true });
async function shot(page: Page, name: string, suffix: string) {
  await page.screenshot({ path: `${out}/${name}-${suffix}.png` });
  console.log(`${name}-${suffix}`);
}
try {
  for (const theme of themes)
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(
        (appearance) =>
          localStorage.setItem(
            "ace.appearance",
            JSON.stringify({
              theme: appearance,
              accent: "theme",
              customAccent: "#7AA2F7",
              glass: 1,
              density: "comfortable",
              transcriptSize: "default",
            }),
          ),
        theme,
      );
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => errors.push(`${theme}-${width}: ${error.message}`));
      const suffix = `${theme}-${width}`;
      const go = async (path: string) => {
        await page.goto(`http://127.0.0.1:5397${path}`);
        await expect(page.locator("header h1").first()).toBeVisible();
      };
      const capture = async (name: string, action: () => Promise<void>) => {
        try {
          await action();
          await shot(page, name, suffix);
        } catch (error) {
          errors.push(
            `${name}-${suffix}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
          );
          await shot(page, `failed-${name}`, suffix);
        }
      };
      const menu = async () => {
        if (width === 390)
          await page.getByRole("button", { name: "Back to threads", exact: true }).click();
        await page.getByRole("button", { name: /, account/ }).click();
      };
      await capture("profile", async () => {
        await go("/t/thread-ux-auth-error");
        await menu();
      });
      await capture("add-project", async () => {
        await go("/new");
        await page.keyboard.press("Meta+k");
        await page.getByRole("combobox", { name: "Search commands" }).fill("Add project");
        await page.getByRole("option", { name: /^Add project/ }).click();
        await expect(page.getByRole("dialog", { name: /Add project/ })).toBeVisible();
      });
      await capture("branch-picker", async () => {
        await go("/new?project=relay");
        await page.getByRole("button", { name: /^Start from:/ }).click();
        await expect(page.getByRole("combobox", { name: "Start from branch" })).toBeVisible();
      });
      await capture("skills-detail", async () => {
        await go("/skills");
        await expect(page.getByRole("heading", { level: 1, name: "Code Review" })).toBeVisible();
      });
      if (width === 1440)
        await capture("skills-filters", async () => {
          await page.getByRole("button", { name: "Filter skills", exact: true }).click();
        });
      await capture("automation-detail", async () => {
        await go("/automations/auto-dependency-audit");
      });
      await capture("automation-editor", async () => {
        await go("/automations/auto-dependency-audit/edit");
      });
      await capture("archived", async () => {
        await go("/archived");
      });
      await capture("setup-step1", async () => {
        await go("/setup");
      });
      for (const step of [2, 3, 4])
        await capture(`setup-step${step}`, async () => {
          await page
            .getByRole("button", { name: step === 2 ? "Get started" : "Continue", exact: true })
            .click();
        });
      await capture("commit-dialog", async () => {
        await go("/t/thread-checkout");
        if (width === 390) {
          await page
            .getByRole("button", { name: /More actions/ })
            .last()
            .click();
          await page.getByRole("menuitem", { name: "Details", exact: true }).click();
        } else await page.getByRole("button", { name: "Work card", exact: true }).click();
        await page.getByRole("button", { name: /Commit & push/ }).click();
        await expect(page.getByRole("dialog", { name: /^Commit to/ })).toBeVisible();
      });
      await capture("reconnecting", async () => {
        await go("/t/thread-cold-start");
        await page.evaluate(() => {
          const fake = Reflect.get(globalThis, "ace");
          if (fake && typeof fake === "object") {
            const daemon = Reflect.get(fake, "daemon");
            if (
              daemon &&
              typeof daemon === "object" &&
              typeof Reflect.get(daemon, "refuseConnections") === "function"
            ) {
              daemon.refuseConnections(true);
              daemon.disconnectAll();
            }
          }
        });
        await expect(page.getByRole("status").filter({ hasText: /^Reconnecting/ })).toBeVisible();
      });
      await capture("offline", async () => {
        await expect(page.getByRole("status").filter({ hasText: /^Offline/ })).toBeVisible({ timeout: 20000 });
      });
      await context.close();
    }
} finally {
  await browser.close();
  await writeFile(`${out}/dialog-capture-report.json`, JSON.stringify({ errors }, null, 2));
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
