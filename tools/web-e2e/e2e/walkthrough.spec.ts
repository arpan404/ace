import { mkdirSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openWorkCard, runAction } from "./thread-header.ts";

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
  // Settling a row: it fades out where it was and the rows below close the gap.
  // The list is virtual: scroll the finished thread into view first.
  const row = threads.getByRole("link", { name: /Haptics on approval and send/ });
  await page.getByRole("complementary", { name: "Threads" }).hover();
  while (!(await row.isVisible())) await page.mouse.wheel(0, 300);
  await row.hover();
  await beat(400);
  await threads.getByRole("button", { name: "Settle Haptics on approval and send" }).click();
  await beat(1200);
  await page.mouse.wheel(0, -5000);
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
  // Send now steers it into the running turn.
  await page.getByRole("button", { name: /^Queued message options:/ }).click();
  await beat(500);
  await page.getByRole("menuitem", { name: "Send now" }).click();
  await beat();

  // Run: the project's script from the work card, in a terminal tab of the side panel.
  await runAction(page, "bun run dev:relay");
  await beat(1200);

  // The agent tree, then Changes with a line comment.
  await page.keyboard.press("Control+Shift+a");
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

  // The right panel closes and opens again on its toggle.
  await page.mouse.move(700, 880);
  await page.getByRole("button", { name: "Right panel" }).click();
  await beat(900);
  await page.getByRole("button", { name: "Right panel" }).click();
  await beat(900);

  // Devices: enable them, then watch the simulator live.
  await panel.getByRole("button", { name: "New tab" }).click();
  await beat(600);
  await panel
    .getByRole("list", { name: "Tools" })
    .getByRole("button", { name: /^Devices/ })
    .click();
  await panel.getByRole("button", { name: "Enable devices" }).click();
  await panel
    .getByRole("list", { name: "Devices" })
    .getByRole("button", { name: /iPhone 16 Pro/ })
    .click();
  const phone = panel.getByRole("region", { name: "iPhone 16 Pro" });
  await phone.getByRole("button", { name: "Start live view" }).click();
  await beat(1500);

  // Commit what changed, from the work card's git actions.
  await page.goto("/t/thread-retry-budget");
  await transcript.waitFor();
  const card = await openWorkCard(page);
  await beat(900);
  await card.getByRole("button", { name: "Git actions" }).click();
  await beat(600);
  await page.getByRole("menuitem", { name: /^Commit…/ }).click();
  await beat(900);
  await page
    .getByRole("dialog", { name: "Commit changes" })
    .getByRole("button", { name: "Commit", exact: true })
    .click();
  await beat(1200);

  // A thread stopped at its account's limit moves to another account.
  await page.goto("/t/thread-limit-search");
  const limit = page.getByRole("region", { name: "Usage limit reached" });
  await limit.waitFor();
  await beat(1200);
  await limit.getByRole("button", { name: "Move to another account" }).click();
  await beat(1200);

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

  // The palette, Activity and Settings, then Light.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("replay", { delay: 40 });
  await beat();
  await page.keyboard.press("Escape");
  for (const [path, name] of [
    ["/activity", "Activity"],
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

/**
 * The workspace and composer: the work card, the launcher, Files with ⌘P, the Browser,
 * reordering, a subagent's tab, a review comment, a device, the terminal, the composer's controls
 * and a thread switch, recorded to /tmp/aceshots-web/walkthrough-workspace.webm.
 */
test("walkthrough of the workspace and composer", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    if (!localStorage.getItem("ace.appearance"))
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: "dark" }));
  });
  const panel = page.getByRole("region", { name: "Thread panel" });
  const launch = async (tool: string) => {
    await panel.getByRole("button", { name: "New tab" }).click();
    await beat(600);
    await panel
      .getByRole("list", { name: "Tools" })
      .getByRole("button", { name: new RegExp(`^${tool}`) })
      .click();
    await beat();
  };

  await page.goto("/t/thread-cold-start");
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  await beat(1000);

  // The work card: changes, branch, actions, editors and sources at a glance.
  await openWorkCard(page);
  await beat(1200);
  await page.keyboard.press("Escape");
  await beat(500);

  // The side panel and its launcher.
  await page.getByRole("button", { name: "Right panel" }).click();
  await beat();
  await launch("Preview");

  // ⌘P quick open, then the checkout tree beside the file.
  await page.keyboard.press("ControlOrMeta+p");
  await beat(500);
  await page.getByRole("combobox", { name: "Search files" }).pressSequentially("replay.ts", {
    delay: 40,
  });
  await page.getByRole("option", { name: /replay\.ts/ }).waitFor();
  await beat(500);
  await page.keyboard.press("Enter");
  await panel.getByRole("region", { name: "Source of apps/server/src/replay.ts" }).waitFor();
  await beat();
  await panel.getByRole("button", { name: "Show the file tree" }).click();
  await beat(1000);
  await panel.getByRole("treeitem", { name: "outbox.ts" }).click();
  await beat(1000);

  // A page from the new tab's address bar.
  await panel.getByRole("button", { name: "New tab" }).click();
  const address = panel.getByRole("combobox", { name: "Address" });
  await address.pressSequentially("docs.example.com/guide", { delay: 30 });
  await address.press("Enter");
  await panel.getByRole("img", { name: "Live view of https://docs.example.com/guide" }).waitFor();
  await beat(1200);

  // Reorder: Preview moves before Agents.
  await panel
    .getByRole("tab", { name: /^(Preview|web · :\d+)/ })
    .dragTo(panel.getByRole("tab", { name: "Agents" }), { targetPosition: { x: 4, y: 8 } });
  await beat();

  // A subagent as its own tab, and back to the tree.
  await panel.getByRole("tab", { name: "Agents" }).click();
  await beat(600);
  await panel.getByRole("treeitem", { name: /^resume-sweep:/ }).click();
  await panel.getByRole("region", { name: "Delegation" }).waitFor();
  await beat(1200);
  await panel.getByRole("button", { name: /Back to agents/ }).click();
  await beat(600);

  // A review comment on the diff goes to the agent.
  await panel.getByRole("tab", { name: /^Changes/ }).click();
  const file = panel.getByRole("region", { name: "apps/server/src/replay.ts" });
  const line = file.getByText(/client.send\(\{ type: "resume.ack", headSeq/);
  await line.hover();
  await line.getByRole("button", { name: /^Comment on line \d+$/ }).click();
  await file
    .getByRole("textbox", { name: /Comment on line/ })
    .pressSequentially("Carry coldStartWindow too?", { delay: 25 });
  await file.getByRole("button", { name: "Comment", exact: true }).click();
  await beat(600);
  await panel
    .getByRole("region", { name: "Review" })
    .getByRole("button", { name: "Send comment to agent" })
    .click();
  await beat(1200);

  // The terminal: ⌘J shows it in the side panel; a new shell, then the panel hidden and a
  // terminal shown again with ⌘J.
  await page.keyboard.press("ControlOrMeta+j");
  await panel.getByRole("tab", { name: "zsh", selected: true }).waitFor();
  await beat(600);
  await panel.getByRole("button", { name: /^Terminal sessions/ }).click();
  await beat(500);
  await page.getByRole("menuitem", { name: /^New terminal/ }).click();
  await panel.getByRole("tab", { name: "zsh 2", selected: true }).waitFor();
  await panel.getByRole("group", { name: "zsh 2 terminal" }).click();
  await page.keyboard.type("git status", { delay: 40 });
  await page.keyboard.press("Enter");
  await beat(1200);
  await panel.getByRole("button", { name: "Right panel" }).click();
  await beat(700);
  await page.keyboard.press("ControlOrMeta+j");
  await beat(1000);

  // The composer: two lines, an attachment, approvals and the model menu.
  const message = page.getByRole("combobox", { name: "Message" });
  await message.click();
  await page.keyboard.type("Rerun the relay soak", { delay: 25 });
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("and post the numbers here", { delay: 25 });
  await beat(500);
  await page.getByLabel("Files to attach").setInputFiles({
    name: "soak.log",
    mimeType: "text/plain",
    buffer: Buffer.from("relay soak: 0 drops in 10,000 events"),
  });
  await beat(800);
  await page.getByRole("button", { name: /^Approvals:/ }).click();
  await beat(1000);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Model:/ }).click();
  await beat(1200);
  await page.keyboard.press("Escape");
  await beat(500);

  // Another thread has its own tabs; coming back restores this one's.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("Replay cursor resets", { delay: 30 });
  await beat(500);
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { level: 1, name: /Replay cursor resets/ }).waitFor();
  await beat(1200);
  await page.goBack();
  await page.getByRole("heading", { level: 1, name: /Cap cold-start replay/ }).waitFor();
  await beat(1500);

  // Full view and back to the split.
  await panel.getByRole("button", { name: "Full view" }).click();
  await beat(1200);
  await panel.getByRole("button", { name: /Cap cold-start replay/ }).click();
  await beat(1200);

  const video = page.video();
  await page.close();
  if (video) {
    const target = `${out}/walkthrough-workspace.webm`;
    rmSync(target, { force: true });
    await video.saveAs(target);
    await video.delete();
  }
});
