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

test("the bottom panel's terminal shows the background shell and runs a new terminal", async ({
  page,
}) => {
  await openColdStart(page);
  await page.getByRole("button", { name: "Bottom panel" }).click();
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  await expect(bottom.getByRole("tab", { name: "Terminal", selected: true })).toBeVisible();
  const terminals = bottom.getByRole("tablist", { name: "Terminals" });
  await expect(terminals.getByRole("tab", { name: /relay:soak/ })).toBeVisible();

  await bottom.getByRole("button", { name: "New terminal" }).click();
  const terminal = bottom.getByRole("group", { name: /^Terminal( \d+)? terminal$/ });
  // Keys go to the shell as they are typed, like a real terminal.
  const input = terminal.getByRole("textbox", { name: "Terminal input" });
  await input.pressSequentially("pwd");
  await input.press("Enter");
  await expect(terminal).toContainText("/Users/dev/ace");
});
