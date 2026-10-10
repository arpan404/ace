import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createCapture, expectReady } from "./component-polish-capture.ts";
import { captureThreadExtras } from "./component-polish-extra-shots.ts";
import { captureDialogExtras } from "./component-polish-dialog-shots.ts";
const out = "/tmp/ace-orch/shots/ui-polish-components";
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const browser = await chromium.launch();
const errors: string[] = [];
await mkdir(out, { recursive: true });
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
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(`${theme}-${width}: ${error.message}`));
      const suffix = `${theme}-${width}`;
      const contextCapture = createCapture(page, width, out, suffix, errors);
      const { go, capture } = contextCapture;
      await capture("composer-idle", async () => {
        await go("/t/thread-ux-auth-error");
        await expectReady(
          page.getByRole("combobox", { name: "Message", exact: true }),
        ).toBeVisible();
      });
      await capture("composer-add", async () => {
        await page.getByRole("button", { name: "Add files and context" }).click();
        await expectReady(page.getByRole("listbox", { name: "Add", exact: true })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("composer-commands", async () => {
        const message = page.getByRole("combobox", { name: "Message", exact: true });
        await message.fill("/");
        await expectReady(
          page.getByRole("listbox", { name: "Commands", exact: true }),
        ).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("composer-mentions", async () => {
        await page.getByRole("combobox", { name: "Message", exact: true }).fill("@read");
        await expectReady(page.getByRole("listbox", { name: "Files and threads" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await page.getByRole("combobox", { name: "Message", exact: true }).fill("");
      await capture("model-menu", async () => {
        await page.getByRole("button", { name: /^Model:/ }).click();
        await expectReady(page.getByRole("dialog", { name: "Model and effort" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("permissions", async () => {
        await page.getByRole("button", { name: /^Approvals:/ }).click();
        await expectReady(page.getByRole("menu").last()).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("thread-menu", async () => {
        await page
          .getByRole("button", { name: /More actions/ })
          .last()
          .click();
        await expectReady(page.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
      });
      await capture("rename-field", async () => {
        await page.getByRole("menuitem", { name: /Rename/ }).click();
        await expectReady(page.getByRole("textbox", { name: "Thread title" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("delete-dialog", async () => {
        await page
          .getByRole("button", { name: /More actions/ })
          .last()
          .click();
        await page.getByRole("menuitem", { name: "Delete thread" }).click();
        await expectReady(page.getByRole("dialog", { name: "Delete thread?" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("palette", async () => {
        await page.keyboard.press("Meta+k");
        await expectReady(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("search", async () => {
        await page.keyboard.press("Meta+Shift+k");
        await expectReady(
          page.getByRole("combobox", { name: "Search every thread" }),
        ).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await capture("shortcuts", async () => {
        await page.keyboard.press("Meta+/");
        await expectReady(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
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
          await expectReady(page.getByRole("feed", { name: "Transcript" })).toBeVisible();
        });
      }
      await capture("changes-panel", async () => {
        await go("/t/thread-checkout");
        await page.keyboard.press("Meta+Shift+d");
        await expectReady(page.getByText("No uncommitted changes")).toBeVisible();
      });
      await captureThreadExtras(contextCapture);
      await captureDialogExtras(contextCapture);
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
