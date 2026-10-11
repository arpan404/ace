import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createCapture, expectReady } from "./component-polish-capture.ts";
import { captureThreadExtras } from "./component-polish-extra-shots.ts";
const out = "/tmp/ace-orch/shots/ui-polish-components";
const errors: string[] = [];
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
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
      const shot = createCapture(page, width, out, `${theme}-${width}`, errors);
      const { go, capture } = shot;
      await captureThreadExtras(shot);
      await capture("add-project", async () => {
        await go("/new");
        await page.keyboard.press("Meta+k");
        await page.getByRole("combobox", { name: "Search commands" }).fill("Add project");
        await page.getByRole("option", { name: /^Add project/ }).click();
        await expectReady(
          page.getByRole("dialog", { name: "Add project", exact: true }),
        ).toBeVisible();
      });
      await capture("branch-picker", async () => {
        await go("/new?project=relay");
        if (width === 390) await page.getByRole("button", { name: /^Environment/ }).click();
        await page.getByRole("button", { name: /^Start from:/ }).click();
        await expectReady(page.getByRole("combobox", { name: "Start from branch" })).toBeVisible();
      });
      await capture("palette-noresults", async () => {
        await go("/t/thread-cold-start");
        await page.keyboard.press("Meta+k");
        await page.getByRole("combobox", { name: "Search commands" }).fill("qqzzxx");
        await expectReady(page.getByRole("option", { name: /Search all threads/ })).toBeVisible();
      });
      await capture("search-results", async () => {
        await go("/t/thread-cold-start");
        await page.keyboard.press("Meta+Shift+k");
        await page.getByRole("combobox", { name: "Search every thread" }).fill("replay");
        await expectReady(page.getByRole("option").first()).toBeVisible();
      });
      await capture("search-filters", async () => {
        await page.getByRole("button", { name: "Filters", exact: true }).click();
      });
      await capture("changes-diff", async () => {
        await go("/t/thread-cold-start");
        await page.keyboard.press("Meta+Shift+d");
        await expectReady(
          page.getByRole("region", { name: "apps/server/src/replay.ts", exact: true }),
        ).toBeVisible();
      });
      await capture("changes-review", async () => {
        await page
          .getByRole("button", { name: /^Comment on line / })
          .first()
          .click();
        await page
          .getByRole("textbox", { name: /^Comment on line / })
          .fill("Keep unknown provider fields here.");
        await page.getByRole("button", { name: "Comment", exact: true }).click();
        await expectReady(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
      });
      await context.close();
    }
} finally {
  await writeFile(`${out}/recheck-report.json`, JSON.stringify({ errors }, null, 2));
  await browser.close();
}
