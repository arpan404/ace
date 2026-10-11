import { expect, test } from "@playwright/test";
import { workCardScenario, type FakeDaemon } from "@ace/fake-daemon";

for (const theme of ["light", "dark"])
  for (const width of [1440, 390, 320]) {
    test(`Work details stay usable and preserve the conversation draft in ${theme} at ${width}`, async ({
      page,
    }) => {
      const fixture = workCardScenario("many-agents");
      await page.setViewportSize({ width, height: 700 });
      await page.addInitScript(
        ({ theme: appearance, fixture: scenario }) => {
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: appearance }));
          Object.assign(globalThis, {
            aceFakeSetup: (daemon: FakeDaemon) => {
              daemon.createThread(scenario.thread);
              for (const step of scenario.steps)
                if (step.kind === "facts") daemon.apply(scenario.thread.id, step.facts);
            },
          });
        },
        { theme, fixture },
      );
      await page.goto(`/t/${fixture.thread.id}`);
      const input = page.getByRole("combobox", { name: "Message" });
      await input.fill("Keep this draft while opening the card");
      const toggle = page.getByRole("button", { name: /^Work card/ });
      await toggle.click();
      const card = page.getByRole("complementary", { name: "Work card" });
      await expect(card.getByText("fix/restart-retry", { exact: true })).toBeVisible();
      const surface = card.locator("[data-work-card-surface]");
      const bounds = await surface.boundingBox();
      if (!bounds) throw new Error("Missing Work details");
      expect(bounds.width).toBeGreaterThanOrEqual(Math.min(280, width - 32));
      expect(bounds.height).toBeGreaterThan(200);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
      await expect(card.getByRole("button", { name: "Project actions" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await card.getByRole("button", { name: "7 done" }).click();
      const background = card.getByRole("button", { name: /^Show bun run dev:/ });
      await background.scrollIntoViewIfNeeded();
      await expect(background).toBeInViewport();
      await expect(input).toHaveText("Keep this draft while opening the card");
      await page.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await expect(toggle).toBeFocused();
      await toggle.click();
      await expect(background).toBeInViewport();
      await expect(input).toHaveText("Keep this draft while opening the card");
    });
  }

for (const height of [220, 320]) {
  test(`the last Work action can be fully scrolled into view and used in a ${height}px window`, async ({
    page,
  }) => {
    const fixture = workCardScenario("many-agents");
    await page.setViewportSize({ width: 390, height });
    await page.addInitScript((scenario) => {
      Object.assign(globalThis, {
        aceFakeSetup: (daemon: FakeDaemon) => {
          daemon.createThread(scenario.thread);
          for (const step of scenario.steps)
            if (step.kind === "facts") daemon.apply(scenario.thread.id, step.facts);
        },
      });
    }, fixture);
    await page.goto(`/t/${fixture.thread.id}`);
    await page.getByRole("button", { name: /^Work card/ }).click();
    const card = page.getByRole("complementary", { name: "Work card" });
    await card.getByRole("button", { name: "7 done" }).click();
    const background = card.getByRole("button", { name: /^Show bun run dev:/ });
    await background.scrollIntoViewIfNeeded();
    await expect(background).toBeInViewport({ ratio: 1 });
    const popupBox = await page.locator('[data-slot="popover-content"]').boundingBox();
    const actionBox = await background.boundingBox();
    if (!popupBox || !actionBox) throw new Error("Missing Work action bounds");
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(popupBox.y + popupBox.height - 1);
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(height);
    await background.click();
    await expect(card).toBeHidden();
    await expect(page.getByRole("region", { name: "Thread panel" })).toBeVisible();
  });
}

test("clicking the composer dismisses Work and keeps typing in the draft", async ({ page }) => {
  await page.goto("/t/thread-dedupe");
  const input = page.getByRole("combobox", { name: "Message" });
  await input.fill("Before ");
  const toggle = page.getByRole("button", { name: /^Work card/ });
  await toggle.click();
  const card = page.getByRole("complementary", { name: "Work card" });
  await expect(card).toBeVisible();
  await input.click();
  await expect(card).toBeHidden();
  await expect(input).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type("after dismissal");
  await expect(input).toHaveText("Before after dismissal");
  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
});
