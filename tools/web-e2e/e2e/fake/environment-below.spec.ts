import { expect, test, type Locator, type Page } from "@playwright/test";

const shots = "/tmp/ace-orch/shots/ui-task-rows-env-below";

async function composerBox(page: Page) {
  // Measure the visible input and controls as one box.
  const box = await page.locator('[data-slot="composer"]').boundingBox();
  if (!box) throw new Error("The composer isn't visible");
  return box;
}
async function below(page: Page, strip: Locator) {
  await expect(strip).toBeVisible();
  const box = await composerBox(page);
  const environment = await strip.boundingBox();
  if (!environment) throw new Error("The environment isn't visible");
  // Its top edge tucks behind the composer; its controls remain entirely below the input box.
  expect(environment.y).toBeGreaterThanOrEqual(box.y + box.height - 16);
  const controls = strip.getByRole("button");
  const control = (await controls.count()) ? await controls.first().boundingBox() : null;
  if (control) expect(control.y).toBeGreaterThanOrEqual(box.y + box.height);
  await expect(strip).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function stage(page: Page, theme: string) {
  await page.addInitScript((chosen) => {
    localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen }));
  }, theme);
}
async function chooseEnvironment(page: Page, width: number) {
  if (width === 390) await page.getByRole("button", { name: "Environment", exact: true }).click();
  return page.getByRole("checkbox", { name: "Worktree", exact: true });
}

for (const theme of ["light", "dark"])
  for (const width of [1440, 390]) {
    test(`new thread controls work below the box in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await stage(page, theme);
      await page.goto("/new?project=ace");
      const strip = page.getByRole("region", { name: "Where this thread runs", exact: true });
      await below(page, strip);
      const original = await composerBox(page);
      const toggle = await chooseEnvironment(page, width);
      await expect(toggle).toBeChecked();
      await expect(page.getByText("This Mac", { exact: true })).toBeVisible();
      await toggle.click();
      await expect(page.getByRole("button", { name: /^Start from:/ })).toBeHidden();
      await toggle.click();
      await page.getByRole("button", { name: /^Project:/ }).click();
      await page.getByRole("menuitemradio", { name: "relay", exact: true }).click();
      await expect(page.getByRole("button", { name: "Project: relay", exact: true })).toBeVisible();
      await page.getByRole("button", { name: /^Start from:/ }).click();
      await page.getByRole("combobox", { name: "Start from branch", exact: true }).fill("main");
      await page.getByRole("option", { name: /^main/ }).click();
      if (width === 390) await page.keyboard.press("Escape");
      await page.getByRole("combobox", { name: "Message", exact: true }).focus();
      await below(page, strip);
      expect((await composerBox(page)).height).toBe(original.height);
      await page.screenshot({
        animations: "disabled",
        path: `${shots}/new-thread-${theme}-${width}.png`,
      });
    });

    test(`follow-up environment stays below questions and plans in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await stage(page, theme);
      await page.goto("/t/thread-ux-pending-full-access");
      const message = page.getByRole("combobox", { name: "Message", exact: true });
      await expect(message).toBeVisible();
      const environment = page.getByRole("region", { name: "Environment", exact: true });
      await below(page, environment);
      const request = page.getByRole("region", { name: "Waiting for you", exact: true });
      await expect(request).toBeVisible();
      const box = await composerBox(page);
      const card = await request.boundingBox();
      if (!card) throw new Error("The approval isn't visible");
      expect(card.y).toBeLessThan(box.y);
      await expect(request.getByRole("button", { name: "Allow once", exact: true })).toBeInViewport(
        { ratio: 1 },
      );
      await environment.getByRole("button", { name: /^Environment:/ }).click();
      const details = page.getByRole("region", { name: "Where this thread runs", exact: true });
      await expect(details).toBeVisible();
      await expect(request).toBeVisible();
      await details.getByRole("button", { name: "Close", exact: true }).click();
      await expect(message).toBeFocused();
      await page.screenshot({
        animations: "disabled",
        path: `${shots}/follow-up-${theme}-${width}.png`,
      });

      await page.goto("/t/thread-install-page");
      const plan = page.getByRole("region", { name: "Plan", exact: true });
      await expect(plan).toBeVisible();
      const planBox = await plan.boundingBox();
      expect(planBox?.y).toBeLessThan((await composerBox(page)).y);
      await below(page, page.getByRole("region", { name: "Environment", exact: true }));
      await expect(
        page.getByText("Drafting the page from the daemon's CLI help.", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        path: `${shots}/plan-${theme}-${width}.png`,
      });
    });
  }

test("worktree creation keeps a draft available with progress below its box", async ({ page }) => {
  await stage(page, "dark");
  await page.goto("/new?project=ace&fakeWorktree=slow");
  await page
    .getByRole("combobox", { name: "Message", exact: true })
    .fill("Test reconnect recovery");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const environment = page.getByRole("region", { name: "Environment", exact: true });
  await expect(environment.getByText("Creating worktree…", { exact: true })).toBeVisible();
  await below(page, environment);
  const message = page.getByRole("combobox", { name: "Message", exact: true });
  await message.fill("Also check the interrupted stream");
  await expect(message).toHaveText("Also check the interrupted stream");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.screenshot({
    animations: "disabled",
    path: `${shots}/creating-worktree-dark-1440.png`,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(environment.getByText("Worktree cancelled", { exact: true })).toBeVisible();
  await expect(message).toHaveText("Also check the interrupted stream");
});

for (const theme of ["midnight", "graphite", "paper", "slate", "contrast"])
  test(`the environment fits a phone in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stage(page, theme);
    await page.goto("/new?project=ace");
    await below(page, page.getByRole("region", { name: "Where this thread runs", exact: true }));
    const toggle = await chooseEnvironment(page, 390);
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press("Escape");
    await page.getByRole("combobox", { name: "Message", exact: true }).focus();
    await page.screenshot({ animations: "disabled", path: `${shots}/new-thread-${theme}-390.png` });
    await page.goto("/t/thread-install-page");
    await expect(page.getByRole("region", { name: "Plan", exact: true })).toBeVisible();
    await below(page, page.getByRole("region", { name: "Environment", exact: true }));
    await expect(
      page.getByText("Drafting the page from the daemon's CLI help.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ animations: "disabled", path: `${shots}/plan-${theme}-390.png` });
  });
