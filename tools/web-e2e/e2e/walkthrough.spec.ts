import { mkdirSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Records one continuous walkthrough of the core journeys against the fake daemon to
 * /tmp/aceshots-web/walkthrough.webm, for design review of motion and flow. Run on demand:
 * `bun run --filter @ace/web-e2e walkthrough`.
 */
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-web";
mkdirSync(out, { recursive: true });

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

// A person's pace, so motion and streaming read in the recording.
const beat = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

test("walkthrough of the core journeys", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    if (!localStorage.getItem("ace.appearance"))
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: "dark" }));
  });

  // Home opens on the top thread; then another from the list.
  await page.goto("/");
  await page.waitForURL(/\/t\//);
  await beat(1200);
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: /Replay cursor resets on every resume/ }).click();
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await transcript.waitFor();
  await beat(1200);

  // The work log opens to its steps.
  await transcript
    .getByRole("button", { name: /^Worked for/ })
    .first()
    .click();
  await beat();

  // A message queued behind the busy agent.
  const message = page.getByRole("combobox", { name: "Message" });
  await message.pressSequentially("Also check the iOS cold-start path", { delay: 25 });
  await message.press("Enter");
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await beat();

  // The agent tree, then Changes with a line comment.
  await page.keyboard.press("ControlOrMeta+j");
  await beat(1000);
  await page.goto("/t/thread-cold-start");
  await transcript.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+d");
  const panel = page.getByRole("region", { name: "Thread panel" });
  const file = panel.getByRole("region", { name: "apps/server/src/replay.ts" });
  const line = file.getByText(/client.send\(\{ type: "resume.ack", headSeq/);
  await line.hover();
  await line.getByRole("button", { name: /^Comment on line \d+$/ }).click();
  await file
    .getByRole("textbox", { name: /Comment on line/ })
    .pressSequentially("Should the ack also carry `coldStartWindow`?", { delay: 20 });
  await file.getByRole("button", { name: "Comment", exact: true }).click();
  await beat();

  // The bottom panel's terminal.
  await page.getByRole("button", { name: "Bottom panel" }).click();
  await beat(1000);

  // A new thread whose first message streams in.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Message" })
    .pressSequentially("Log every restart with its backoff delay", { delay: 25 });
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("feed", { name: "Transcript" })
      .getByText("Reading the project before making changes."),
  ).toBeVisible();
  await beat(2000);

  // The palette, Activity, Deck and Settings, then Light.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("replay", { delay: 40 });
  await beat();
  await page.keyboard.press("Escape");
  for (const [path, name] of [
    ["/activity", "Activity"],
    ["/deck", "Resumable relay streams"],
    ["/settings/appearance", "Settings"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await beat(1200);
  }
  await page.evaluate(() =>
    localStorage.setItem("ace.appearance", JSON.stringify({ theme: "light" })),
  );
  await page.goto("/");
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  await beat(1500);

  const video = page.video();
  await page.close();
  if (video) {
    const target = `${out}/walkthrough.webm`;
    rmSync(target, { force: true });
    await video.saveAs(target);
    await video.delete();
  }
});
