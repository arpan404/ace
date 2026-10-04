import { mkdirSync, rmSync } from "node:fs";
import { test } from "@playwright/test";

/**
 * Records the long-thread journeys against the fake daemon's five-day migration to
 * /tmp/aceshots-web/walkthrough-long-thread.webm, for design review of motion and flow:
 * catching up, following and leaving the live end, the turn timeline, jumping across days and
 * reading back to the present, moving turn by turn, and searching the thread. Run on demand:
 * `bun run --filter @ace/web-e2e walkthrough`.
 */
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-web";
mkdirSync(out, { recursive: true });

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

const beat = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
const mod = "ControlOrMeta";

test("walkthrough of a long thread", async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    if (!localStorage.getItem("ace.appearance"))
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: "dark" }));
  });

  // Back after a day away: what happened meanwhile.
  await page.goto("/t/thread-multi-day");
  const feed = page.getByRole("feed", { name: "Transcript" });
  await feed.waitFor();
  const card = page.getByRole("region", { name: "While you were away" });
  await card.waitFor();
  await beat(2_500);
  await card.getByRole("button", { name: "Dismiss" }).click();
  await beat();

  // Scrolling up leaves the live end; Jump to live brings it back.
  await feed.hover();
  for (let step = 0; step < 4; step++) {
    await page.mouse.wheel(0, -350);
    await beat(250);
  }
  await beat(900);
  await page.getByRole("button", { name: /^Jump to live/ }).click();
  await beat(1_000);

  // The turns of five days, and a jump to the first week's checkpoint.
  await page.keyboard.press(`Shift+${mod}+o`);
  await page.getByRole("option", { name: /^Turn 24: / }).waitFor();
  await beat(900);
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press("ArrowUp");
    await beat(90);
  }
  await page.keyboard.press("PageUp");
  await beat(600);
  await page.keyboard.press("Enter");
  await page.getByRole("status", { name: "Jumped" }).waitFor();
  await beat(1_500);
  await page.keyboard.press("Escape");
  await beat(500);

  // Older turns above fold to one line; one opens.
  await feed.hover();
  await page.mouse.wheel(0, -400);
  await beat(800);
  await feed
    .getByRole("button", { name: /Show the turn$/ })
    .first()
    .click();
  await beat(1_200);

  // Reading on toward the present: the window slides, never leaving a hole.
  for (let step = 0; step < 6; step++) {
    await page.mouse.wheel(0, 1_400);
    await beat(350);
  }
  await beat(800);

  // Turn by turn.
  await page.keyboard.press(`Alt+${mod}+ArrowDown`);
  await beat(900);
  await page.keyboard.press(`Alt+${mod}+ArrowDown`);
  await beat(900);
  await page.keyboard.press(`Alt+${mod}+ArrowUp`);
  await beat(900);

  // Search the whole thread and step through what it finds.
  await page.keyboard.press(`${mod}+f`);
  await beat(400);
  await page.keyboard.type("validation failed", { delay: 45 });
  await page.getByRole("search", { name: "Search this thread" }).getByText("3 results").waitFor();
  await beat(1_200);
  for (let hit = 0; hit < 3; hit++) {
    await page.keyboard.press("Enter");
    await beat(1_300);
  }
  await page.keyboard.press("Escape");
  await beat(600);

  // And back to the live end.
  await page
    .getByRole("button", { name: /^Jump to live/ })
    .first()
    .click();
  await beat(1_800);

  const video = page.video();
  await page.close();
  if (video) {
    const target = `${out}/walkthrough-long-thread.webm`;
    rmSync(target, { force: true });
    await video.saveAs(target);
    await video.delete();
  }
});
