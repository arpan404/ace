import { expect, test, type Page } from "@playwright/test";

async function openColdStart(page: Page) {
  await page.goto("/t/thread-cold-start");
  await expect(
    page.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
  ).toBeVisible();
}

/** Review in Changes, subagent tabs and ace's permission reviews, against the fake daemon. */
test("a review comment goes from draft to the agent, then is resolved", async ({ page }) => {
  await openColdStart(page);
  await page.keyboard.press("ControlOrMeta+Shift+d");
  const panel = page.getByRole("region", { name: "Thread panel" });
  const file = panel.getByRole("region", { name: "apps/server/src/replay.ts" });
  const line = file.getByText(/client.send\(\{ type: "resume.ack", headSeq/);
  await line.hover();
  await line.getByRole("button", { name: /^Comment on line \d+$/ }).click();
  await file.getByRole("textbox", { name: /Comment on line/ }).fill("Carry coldStartWindow too?");
  await file.getByRole("button", { name: "Comment", exact: true }).click();

  const review = panel.getByRole("region", { name: "Review" });
  await expect(review.getByRole("status")).toHaveText("1 comment to send");
  await review.getByRole("button", { name: "Send comment to agent" }).click();
  await expect(review.getByRole("status")).toHaveText("1 waiting for the agent");
  await expect(page.getByText(/Review comments to address:/)).toBeVisible();

  const card = file.getByRole("article", { name: /Comment on line/ });
  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(card.getByText("Resolved", { exact: true })).toBeVisible();
  await expect(review.getByRole("status")).toHaveText("1 resolved");
});

test("the files tree jumps to a file and the layout menu switches to split", async ({ page }) => {
  await openColdStart(page);
  await page.keyboard.press("ControlOrMeta+Shift+d");
  const panel = page.getByRole("region", { name: "Thread panel" });
  const tree = panel.getByRole("tree", { name: "Changed files" });
  await tree.getByRole("treeitem", { name: /^apps\/web\/src\/relay\/outbox\.ts/ }).click();
  await expect(
    tree.getByRole("treeitem", { name: /^apps\/web\/src\/relay\/outbox\.ts/, selected: true }),
  ).toBeVisible();

  await panel.getByRole("button", { name: /^Diff layout/ }).click();
  await page.getByRole("menuitemradio", { name: /^Split/ }).click();
  await expect(panel.getByRole("button", { name: "Diff layout: Split" })).toBeVisible();
});

test("a subagent opens as its own tab and Back returns to the tree", async ({ page }) => {
  await openColdStart(page);
  await page.keyboard.press("Control+Shift+a");
  const panel = page.getByRole("region", { name: "Thread panel" });
  await panel.getByRole("button", { name: "Open resume-sweep" }).click();
  await expect(panel.getByRole("tab", { name: "resume-sweep", selected: true })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Delegation" })).toContainText(
    "Sweep the web and mobile resume callers",
  );
  await expect(panel.getByRole("textbox", { name: "Message resume-sweep" })).toBeDisabled();

  await panel.getByRole("button", { name: /Back to agents/ }).click();
  await expect(panel.getByRole("tab", { name: "Agents", selected: true })).toBeVisible();
});

test("ace's permission reviews read in the transcript and on the request that reached Activity", async ({
  page,
}) => {
  await page.goto("/t/thread-release-audit");
  const feed = page.getByRole("feed", { name: "Transcript" });
  const denied = feed.getByRole("article", { name: "Permission review: Denied by ace" });
  await expect(denied).toContainText("Destructive command is outside the automatic risk policy");
  await denied.getByRole("button").click();
  await expect(denied.getByText("rm -rf dist")).toBeVisible();

  await page.goto("/activity");
  const request = page.getByRole("article", { name: /npm publish --dry-run/ });
  await expect(request.getByRole("region", { name: "ace's review" })).toContainText(
    "Command is not in the low-risk allowlist",
  );
});
