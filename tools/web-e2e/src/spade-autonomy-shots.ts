import { chromium, type Page } from "@playwright/test";
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/spade-autonomy-shots";
const base = process.env.ACE_WEB_URL ?? "http://localhost:5391";
const world = "fakeWorld=spade";
const browser = await chromium.launch();
const settle = (page: Page) => page.waitForTimeout(1500);
try {
  for (const mode of ["dark", "light"])
    for (const width of [1440, 1024, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(
        (value) => localStorage.setItem("ace.appearance", JSON.stringify({ mode: value })),
        mode,
      );
      const page = await context.newPage();
      const shot = async (name: string) => {
        await page.screenshot({
          path: `${out}/${name}-${mode}-${width}.png`,
          animations: "disabled",
        });
        console.log(`${name}-${mode}-${width}`);
      };
      const go = async (path: string, ready: string) => {
        await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}${world}`);
        await page.getByText(ready).first().waitFor({ timeout: 30_000 });
        await settle(page);
      };
      await go("/spade/inbox", "so you decide");
      await shot("escalation");
      await go("/spade/flights", "changed nothing");
      await shot("task-paused");
      await go("/spade/notes", "is working on it");
      await shot("continuing");
      await go("/spade", "Research");
      await page.getByText("Research", { exact: true }).first().click();
      await page.getByText("Research is waiting").first().waitFor({ timeout: 30_000 });
      await settle(page);
      await shot("waiting");
      await go("/spade/flights?view=activity", "The reviewer");
      await shot("activity");
      await go("/spade/notes?view=bot", "Full access");
      await page.getByText("Never asks").first().scrollIntoViewIfNeeded();
      await shot("bot-page-access");
      await page
        .getByRole("radio", { name: "Ask" })
        .first()
        .click()
        .catch(() => {});
      await go("/spade/inbox?view=bot", "Auto-review");
      await page.getByRole("radio", { name: "Full access" }).click();
      await page.getByRole("dialog").waitFor();
      await settle(page);
      await shot("full-access-confirm");
      await go("/spade", "Working on it");
      await shot("roster");
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.getByRole("menuitem", { name: "New bot" }).click();
      await page.getByRole("dialog", { name: "New bot" }).waitFor();
      await settle(page);
      await page.getByText("Never asks").scrollIntoViewIfNeeded();
      await shot("new-bot");
      await go("/settings/spade", "Review model");
      await page.getByText("Review model", { exact: true }).first().scrollIntoViewIfNeeded();
      await shot("review-model");
      await context.close();
    }
} finally {
  await browser.close();
}
