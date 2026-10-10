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
      page.setDefaultTimeout(30000);
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
      await capture("composer-idle", async () => {
        await go("/t/thread-ux-auth-error");
        await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
      });
      await capture("composer-add", async () => {
        await page.getByRole("button", { name: "Add files and context" }).click();
        await expect(page.getByRole("listbox", { name: "Add", exact: true })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("composer-commands", async () => {
        const message = page.getByRole("combobox", { name: "Message", exact: true });
        await message.fill("/");
        await expect(page.getByRole("listbox", { name: "Commands", exact: true })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("composer-mentions", async () => {
        await page.getByRole("combobox", { name: "Message", exact: true }).fill("@read");
        await expect(page.getByRole("listbox", { name: "Files and threads" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await page.getByRole("combobox", { name: "Message", exact: true }).fill("");
      await capture("model-menu", async () => {
        await page.getByRole("button", { name: /^Model:/ }).click();
        await expect(page.getByRole("dialog", { name: "Model and effort" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("permissions", async () => {
        await page.getByRole("button", { name: /^Approvals:/ }).click();
        await expect(page.getByRole("menu").last()).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("thread-menu", async () => {
        await page
          .getByRole("button", { name: /More actions/ })
          .last()
          .click();
        await expect(page.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
      });
      await capture("rename-field", async () => {
        await page.getByRole("menuitem", { name: /Rename/ }).click();
        await expect(page.getByRole("textbox", { name: "Thread title" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("delete-dialog", async () => {
        await page
          .getByRole("button", { name: /More actions/ })
          .last()
          .click();
        await page.getByRole("menuitem", { name: "Delete thread" }).click();
        await expect(page.getByRole("dialog", { name: "Delete thread?" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("palette", async () => {
        await page.keyboard.press("Meta+k");
        await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("search", async () => {
        await page.keyboard.press("Meta+Shift+k");
        await expect(page.getByRole("combobox", { name: "Search every thread" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("shortcuts", async () => {
        await page.keyboard.press("Meta+/");
        await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      for (const [path, name] of [
        ["/t/thread-retry-budget", "approval"],
        ["/t/thread-sheet-rotate", "question"],
        ["/t/thread-cold-start", "transcript"],
        ["/t/thread-install-page", "plan"],
        ["/t/thread-ux-switch-handoff", "handoff"],
      ]) {
        await capture(name ?? "thread", async () => {
          await go(path ?? "/");
          await expect(page.getByRole("feed", { name: "Transcript" })).toBeVisible();
        });
      }
      await capture("changes-panel", async () => {
        await go("/t/thread-checkout");
        await page.keyboard.press("Meta+Shift+d");
        await expect(page.getByText("No uncommitted changes")).toBeVisible();
      });
      await context.close();
    }
} finally {
  await browser.close();
  await writeFile(`${out}/capture-report.json`, JSON.stringify({ errors }, null, 2));
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
