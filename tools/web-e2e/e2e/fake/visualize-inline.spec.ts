import { expect, test, type Page } from "@playwright/test";

const title = "Binary search, step by step";

async function openExplainer(page: Page) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/t/thread-explainer");
  const section = page
    .getByRole("feed", { name: "Transcript" })
    .getByRole("region", { name: title });
  const content = section.frameLocator("iframe").frameLocator("iframe");
  await expect(content.getByRole("heading", { name: /Binary search halves/ })).toBeVisible();
  return { section, content };
}

test("an interactive page renders inline at the message's width, runs its script and fits its content", async ({
  page,
}) => {
  const { section, content } = await openExplainer(page);
  // Full width of the message column, like the agent's reply below it.
  const frame = section.locator("iframe");
  const reply = page.getByText("Each comparison discards half");
  const [frameBox, replyBox] = await Promise.all([frame.boundingBox(), reply.boundingBox()]);
  expect(frameBox?.width).toBeGreaterThan(560);
  expect(Math.abs((frameBox?.width ?? 0) - (replyBox?.width ?? 0))).toBeLessThanOrEqual(1);

  // Its script runs: the step-through and the slider change the page.
  await expect(content.getByText("Step 0 of 4")).toBeVisible();
  await content.getByRole("button", { name: "Next step" }).click();
  await expect(content.getByText("Step 1 of 4")).toBeVisible();
  await expect(content.locator("#note")).toContainText("Middle is 34");
  await content.getByRole("slider").fill("3");
  await expect(content.locator("#target-value")).toHaveText("18");
  await content.getByRole("button", { name: "About 20" }).click();
  await expect(content.getByText(/Right: 2\^20/)).toBeVisible();

  // The frame is as tall as the page's content: no fixed box, no inner scrollbar.
  const contentHeight = await content.locator("body").evaluate((body) => body.scrollHeight);
  await expect
    .poll(async () => Math.round((await frame.boundingBox())?.height ?? 0))
    .toBe(contentHeight);
  expect(contentHeight).toBeGreaterThan(300);
  await expect(page.getByText("Static view")).toHaveCount(0);
});

test("a theme change reaches the running page without reloading it", async ({ page }) => {
  const { content } = await openExplainer(page);
  await content.getByRole("button", { name: "Next step" }).click();
  await expect(content.getByText("Step 1 of 4")).toBeVisible();
  const variable = (name: string) =>
    content
      .locator("html")
      .evaluate((root, key) => getComputedStyle(root).getPropertyValue(key).trim(), name);
  const appVariable = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    );
  const dark = await variable("--background");
  expect(dark).toBe(await appVariable());

  // The app follows the system scheme; the page follows the app.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  const light = await appVariable();
  expect(light).not.toBe(dark);
  await expect.poll(() => variable("--background")).toBe(light);
  await expect.poll(() => variable("--foreground")).not.toBe("");
  // Same page, same state.
  await expect(content.getByText("Step 1 of 4")).toBeVisible();
});

test("the page's actions stay hidden until the pointer or focus is on it", async ({ page }) => {
  const { section } = await openExplainer(page);
  const open = section.getByRole("button", { name: "Full screen" });
  // The row of actions fades as one; no button is ever drawn on its own.
  const actions = open.locator("xpath=..");
  await page.mouse.move(5, 5);
  await expect(actions).toHaveCSS("opacity", "0");
  await section.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  for (const name of ["Full screen", "Copy source", "Download"])
    await expect(actions.getByRole("button", { name })).toBeVisible();
});

test("plain markup takes ace's own look: a page's button is styled like the app's", async ({
  page,
}) => {
  const { content } = await openExplainer(page);
  const next = content.getByRole("button", { name: "Next step" });
  // Not the browser's default control: the app's corner and font, no outset border.
  await expect(next).not.toHaveCSS("border-style", "outset");
  const radius = await next.evaluate((button) => getComputedStyle(button).borderTopLeftRadius);
  expect(Number.parseFloat(radius)).toBeGreaterThanOrEqual(6);
  const appFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  await expect(next).toHaveCSS("font-family", appFont);
});

test("Full screen shows the same running page beside the conversation", async ({ page }) => {
  const { section } = await openExplainer(page);
  await section.hover();
  await section.getByRole("button", { name: "Full screen" }).click();
  const panel = page
    .getByRole("region", { name: "Thread panel" })
    .getByRole("region", { name: title });
  const content = panel.frameLocator("iframe").frameLocator("iframe");
  await expect(content.getByRole("heading", { name: /Binary search halves/ })).toBeVisible();
  // It runs on its own, and fills the panel rather than fitting its content.
  await content.getByRole("button", { name: "Next step" }).click();
  await expect(content.getByText("Step 1 of 4")).toBeVisible();
  const [frame, box] = await Promise.all([
    panel.locator("iframe").boundingBox(),
    panel.boundingBox(),
  ]);
  expect((frame?.height ?? 0) / (box?.height ?? 1)).toBeGreaterThan(0.8);
  // Opening it again shows the tab already open.
  await section.hover();
  await section.getByRole("button", { name: "Full screen" }).click();
  await expect(page.getByRole("tab", { name: title })).toHaveCount(1);
});
