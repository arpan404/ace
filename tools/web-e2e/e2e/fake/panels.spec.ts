import { expect, test, type Page } from "@playwright/test";

async function openColdStart(page: Page) {
  await page.goto("/t/thread-cold-start");
  await expect(
    page.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
  ).toBeVisible();
}

test("a line comment in Changes is sent to the agent", async ({ page }) => {
  await openColdStart(page);
  await page.keyboard.press("ControlOrMeta+Shift+d");
  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: /^Changes/, selected: true })).toBeVisible();

  const file = panel.getByRole("region", { name: "apps/server/src/replay.ts" });
  const line = file.getByText(/client.send\(\{ type: "resume.ack", headSeq/);
  await line.hover();
  await line.getByRole("button", { name: /^Comment on line \d+$/ }).click();
  await file
    .getByRole("textbox", { name: /Comment on line/ })
    .fill("Should the ack also carry coldStartWindow?");
  await file.getByRole("button", { name: "Comment", exact: true }).click();

  const card = file.getByRole("article", { name: /Comment on line/ });
  await card.getByRole("button", { name: "Send to agent" }).click();
  await expect(card.getByText("Sent to agent")).toBeVisible();
  await expect(page.getByText(/Review comments to address:/)).toBeVisible();
});

/** New terminal, from the sessions menu on the strip while a terminal shows. */
async function newTerminal(page: Page) {
  const panel = page.getByRole("region", { name: "Thread panel" });
  await panel.getByRole("button", { name: /^Terminal sessions/ }).click();
  await page.getByRole("menuitem", { name: /^New terminal/ }).click();
}

test("⌘J's terminal picks up the thread's shell, New terminal opens another and an agent's shell shows read-only", async ({
  page,
}) => {
  await openColdStart(page);
  await page.keyboard.press("ControlOrMeta+j");
  const panel = page.getByRole("region", { name: "Thread panel" });
  // The thread's running zsh had no tab: the side panel's terminal picks it up.
  await expect(panel.getByRole("tab", { name: "zsh", selected: true })).toBeVisible();

  await newTerminal(page);
  await expect(panel.getByRole("tab", { name: "zsh 2", selected: true })).toBeVisible();
  const terminal = panel.getByRole("group", { name: "zsh 2 terminal" });
  // The new terminal has the keyboard: keys go to the shell as they are typed.
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("/Users/dev/ace");

  await panel.getByRole("button", { name: /^Terminal sessions/ }).click();
  await page.getByRole("menuitem", { name: /relay:soak/ }).click();
  await expect(panel.getByRole("tab", { name: "relay:soak", selected: true })).toBeVisible();
  await expect(panel.getByText("Agent shell")).toBeVisible();
  await expect(panel.getByRole("log", { name: "relay:soak output" })).toContainText(
    "soak relay listening on ws://127.0.0.1:8790",
  );
});

test("inside a terminal, Ctrl keys reach the shell instead of ace's shortcuts, and Find searches it", async ({
  page,
}) => {
  await openColdStart(page);
  await page.keyboard.press("ControlOrMeta+j");
  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: "zsh", selected: true })).toBeVisible();
  await newTerminal(page);
  const terminal = panel.getByRole("group", { name: "zsh 2 terminal" });
  await expect(panel.getByRole("tab", { name: "zsh 2", selected: true })).toBeVisible();
  await terminal.click();
  await page.keyboard.type("git status");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("apps/server/src/replay.test.ts");

  // Ctrl+K is the shell's kill-line, not the command palette; Ctrl+P is history, not Files.
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+f");
  const find = panel.getByRole("search", { name: "Find in output" });
  await find.getByRole("searchbox", { name: "Find" }).fill("replay");
  await expect(find.getByRole("status")).toHaveText("2 of 2");
  await page.keyboard.press("Escape");
  await expect(find).toHaveCount(0);
});

test("Logs filter to an agent and to warnings, and copy what they show", async ({ page }) => {
  await openColdStart(page);
  await page.keyboard.press("Control+Shift+l");
  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: "Logs", selected: true })).toBeVisible();
  await panel.getByRole("button", { name: /^Log source/ }).click();
  await page.getByRole("menuitemradio", { name: "resume-sweep" }).click();
  await expect(panel.getByRole("tab", { name: "resume-sweep log", selected: true })).toBeVisible();
  const log = panel.getByRole("list", { name: "resume-sweep log" });
  await expect(log).toContainText("subagent resume-sweep spawned");
  await expect(log).not.toContainText("session started");

  await panel.getByRole("button", { name: /^Log source/ }).click();
  await page.getByRole("menuitemradio", { name: "Thread" }).click();
  await panel.getByRole("button", { name: "Levels and sources" }).click();
  await page.getByRole("menuitemradio", { name: "Warnings and errors" }).click();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("list", { name: "Thread log" })).toContainText(
    "82% of its 5-hour window",
  );
  await expect(panel.getByRole("list", { name: "Thread log" })).not.toContainText("turn started");
});
