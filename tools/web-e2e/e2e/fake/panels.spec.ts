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

test("the bottom panel picks up the thread's shell, opens a new terminal and shows an agent's shell read-only", async ({
  page,
}) => {
  await openColdStart(page);
  await page.getByRole("button", { name: "Bottom panel" }).click();
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  // The thread's running zsh had no tab: the bottom panel's terminal picks it up.
  await expect(bottom.getByRole("tab", { name: "zsh", selected: true })).toBeVisible();

  await bottom.getByRole("button", { name: "New terminal" }).click();
  await expect(bottom.getByRole("tab", { name: "Terminal", selected: true })).toBeVisible();
  const terminal = bottom.getByRole("group", { name: "Terminal terminal" });
  // The new terminal has the keyboard: keys go to the shell as they are typed.
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("/Users/dev/ace");

  await bottom.getByRole("button", { name: /^Terminal sessions/ }).click();
  await page.getByRole("menuitem", { name: /relay:soak/ }).click();
  await expect(bottom.getByRole("tab", { name: "relay:soak", selected: true })).toBeVisible();
  await expect(bottom.getByText("Agent shell")).toBeVisible();
  await expect(bottom.getByRole("log", { name: "relay:soak output" })).toContainText(
    "soak relay listening on ws://127.0.0.1:8790",
  );
});

test("inside a terminal, Ctrl keys reach the shell instead of ace's shortcuts, and Find searches it", async ({
  page,
}) => {
  await openColdStart(page);
  await page.getByRole("button", { name: "Bottom panel" }).click();
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  await bottom.getByRole("button", { name: "New terminal" }).click();
  const terminal = bottom.getByRole("group", { name: "Terminal terminal" });
  await expect(bottom.getByRole("tab", { name: "Terminal", selected: true })).toBeVisible();
  await page.keyboard.type("git status");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("apps/server/src/replay.test.ts");

  // Ctrl+K is the shell's kill-line, not the command palette; Ctrl+P is history, not Files.
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+f");
  const find = bottom.getByRole("search", { name: "Find in output" });
  await find.getByRole("searchbox", { name: "Find" }).fill("replay");
  await expect(find.getByRole("status")).toHaveText("2 of 2");
  await page.keyboard.press("Escape");
  await expect(find).toHaveCount(0);
});

test("Logs filter to an agent and to warnings, and copy what they show", async ({ page }) => {
  await openColdStart(page);
  await page.keyboard.press("Control+Shift+l");
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  await expect(bottom.getByRole("tab", { name: "Logs", selected: true })).toBeVisible();
  await bottom.getByRole("button", { name: /^Log source/ }).click();
  await page.getByRole("menuitemradio", { name: "resume-sweep" }).click();
  await expect(bottom.getByRole("tab", { name: "resume-sweep log", selected: true })).toBeVisible();
  const log = bottom.getByRole("list", { name: "resume-sweep log" });
  await expect(log).toContainText("subagent resume-sweep spawned");
  await expect(log).not.toContainText("session started");

  await bottom.getByRole("button", { name: /^Log source/ }).click();
  await page.getByRole("menuitemradio", { name: "Thread" }).click();
  await bottom.getByRole("button", { name: "Levels and sources" }).click();
  await page.getByRole("menuitemradio", { name: "Warnings and errors" }).click();
  await page.keyboard.press("Escape");
  await expect(bottom.getByRole("list", { name: "Thread log" })).toContainText(
    "82% of its 5-hour window",
  );
  await expect(bottom.getByRole("list", { name: "Thread log" })).not.toContainText("turn started");
});
