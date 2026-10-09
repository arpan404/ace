import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`Work card stays inline, bounded and keyboard foldable in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.addInitScript(
        (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
        theme,
      );
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/t/thread-refund-tax?fakeWorld=thread-activity");
      const input = page.getByRole("combobox", { name: "Message", exact: true });
      await expect(input).toBeVisible();
      await input.fill("Keep this draft while opening the card");
      let toggle = page.getByRole("button", { name: "Work card", exact: true });
      if (!(await toggle.isVisible()))
        await page.getByRole("button", { name: "More actions", exact: true }).first().click();
      await toggle.click();
      const card = page.getByRole("complementary", { name: "Work card", exact: true });
      await expect(card).toBeVisible();
      await expect(input).toHaveText("Keep this draft while opening the card");
      await expect(
        page
          .locator('[data-slot="composer"]')
          .getByRole("region", { name: "Environment", exact: true }),
      ).toHaveCount(0);
      await expect(async () => {
        const context = await card.boundingBox();
        const conversation = await page.locator("[data-thread-column]").boundingBox();
        const composer = await page.locator('[data-slot="composer"]').boundingBox();
        if (!context || !conversation || !composer) throw new Error("Missing inline layout");
        if (width > 832)
          expect(context.x).toBeGreaterThanOrEqual(conversation.x + conversation.width);
        else expect(context.y + context.height).toBeLessThanOrEqual(conversation.y + 1);
        expect(context.x).toBeGreaterThanOrEqual(0);
        expect(context.x + context.width).toBeLessThanOrEqual(width);
        expect(composer.y + composer.height).toBeLessThanOrEqual(700);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
      }).toPass();
      for (const title of ["Environment", "Changes", "Pull requests", "Actions"]) {
        const section = card.getByRole("button", { name: title, exact: true });
        await section.focus();
        await page.keyboard.press("Space");
        await expect(section).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press("Enter");
        await expect(section).toHaveAttribute("aria-expanded", "true");
      }
      const environment = card.getByRole("region", { name: "Where this thread runs", exact: true });
      await expect(
        environment.getByRole("button", { name: "Copy path", exact: true }),
      ).toBeVisible();
      await expect(environment.getByText("Machine", { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Environment", exact: true }).click();
      await card.getByRole("button", { name: "Close work card", exact: true }).click();
      if (!(await toggle.isVisible()))
        await page.getByRole("button", { name: "More actions", exact: true }).first().click();
      await toggle.click();
      await expect(card.getByRole("button", { name: "Environment", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(input).toHaveText("Keep this draft while opening the card");
      await page.screenshot({
        animations: "disabled",
        path: `/tmp/ace-work-card-${theme}-${width}.png`,
      });
      expect(errors).toEqual([]);
    });

for (const height of [800, 400])
  test(`a long Work card scrolls inside its desktop cap at height ${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height });
    await page.addInitScript(() =>
      Object.assign(globalThis, {
        aceFakeSetup: (daemon: { setScripts(id: string, names: string[]): void }) =>
          daemon.setScripts(
            "relay",
            Array.from({ length: 24 }, (_, index) => `check-${String(index).padStart(2, "0")}`),
          ),
      }),
    );
    await page.goto("/t/thread-replay-cursor?fakeWorld=thread-activity");
    await page.getByRole("button", { name: "Work card", exact: true }).click();
    const card = page.getByRole("complementary", { name: "Work card", exact: true });
    const surface = card.locator("[data-work-card-scroll]");
    const actions = card.getByRole("list", { name: "Project actions", exact: true });
    await expect(actions.getByRole("button")).toHaveCount(24);
    const cardHeight = await card
      .locator("[data-work-card-surface]")
      .evaluate((node) => node.clientHeight);
    expect(cardHeight).toBeLessThanOrEqual(480);
    const geometry = await surface.evaluate((node) => ({
      height: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(geometry.height).toBeLessThanOrEqual(480);
    expect(geometry.height).toBeLessThanOrEqual(height - 48 - 24);
    expect(geometry.scrollHeight).toBeGreaterThan(700);
    expect(await actions.evaluate((node) => getComputedStyle(node).overflowY)).toBe("visible");
    const initialDocumentScroll = await page.evaluate(() => scrollY);
    await surface.hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => surface.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => scrollY)).toBe(initialDocumentScroll);
    const last = actions.getByRole("button").last();
    await last.focus();
    await expect(last).toBeFocused();
    const bounds = await surface.boundingBox();
    const end = await last.boundingBox();
    expect(
      bounds && end && end.y >= bounds.y && end.y + end.height <= bounds.y + bounds.height + 1,
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1440,
    );
    await page.screenshot({
      path: `/tmp/ace-work-card-height-${height}.png`,
      animations: "disabled",
    });
    if (height === 800) {
      const saved = await surface.evaluate((node) => node.scrollTop);
      // Let the native scrollend gesture boundary persist the final position.
      await page.waitForTimeout(250);
      await page.locator('[data-thread-row="thread-sheet-rotate"]').getByRole("link").click();
      await expect(card).toBeHidden();
      await page.goBack();
      await expect(card).toBeVisible();
      await expect.poll(() => surface.evaluate((node) => node.scrollTop)).toBe(saved);
      await page.reload();
      await expect(actions.getByRole("button")).toHaveCount(24);
      await expect.poll(() => surface.evaluate((node) => node.scrollTop)).toBe(saved);
      // Route away while the scroll gesture still has no scrollend event.
      const immediate = await surface.evaluate((node) => {
        node.scrollTop = 80;
        return node.scrollTop;
      });
      await page.locator('[data-thread-row="thread-sheet-rotate"]').getByRole("link").click();
      await page.goBack();
      await expect(card).toBeVisible();
      await expect.poll(() => surface.evaluate((node) => node.scrollTop)).toBe(immediate);
    }
  });

test("Work card view state stays independent across thread navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.addInitScript(() =>
    Object.assign(globalThis, {
      aceFakeSetup: (daemon: { setScripts(id: string, names: string[]): void }) =>
        daemon.setScripts("relay", ["dev", "test", "build", "lint", "soak"]),
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/t/thread-replay-cursor?fakeWorld=thread-activity");
  const card = page.getByRole("complementary", { name: "Work card", exact: true });
  await page.getByRole("button", { name: "Work card", exact: true }).click();
  await card.getByRole("button", { name: "Environment", exact: true }).click();
  await card.getByRole("searchbox", { name: "Search actions", exact: true }).fill("soak");
  const a = page.url();
  await page.locator('[data-thread-row="thread-sheet-rotate"]').getByRole("link").click();
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "Work card", exact: true }).click();
  await expect(card.getByRole("button", { name: "Environment", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await card.getByRole("button", { name: "Changes", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(a);
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Environment", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(card.getByRole("button", { name: "Changes", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(card.getByRole("searchbox", { name: "Search actions", exact: true })).toHaveValue(
    "soak",
  );
  await card.getByRole("button", { name: "Close work card", exact: true }).click();
  await page.goForward();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Changes", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.goBack();
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "Work card", exact: true }).click();
  await expect(card.getByRole("searchbox", { name: "Search actions", exact: true })).toHaveValue(
    "soak",
  );
  await page.reload();
  await expect(card).toBeVisible();
  await expect(card.getByRole("searchbox", { name: "Search actions", exact: true })).toHaveValue(
    "soak",
  );
  expect(errors).toEqual([]);
});
