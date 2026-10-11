import { expect, test } from "@playwright/test";
import { workCardScenario, type FakeDaemon } from "@ace/fake-daemon";

for (const theme of ["light", "dark"])
  for (const width of [1440, 390]) {
    test(`the slim card stays inline and scrolls without covering the conversation in ${theme} at ${width}`, async ({
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
      const conversation = await page.locator("[data-thread-column]").boundingBox();
      if (!bounds || !conversation) throw new Error("Missing inline layout");
      expect(bounds.width).toBe(232);
      expect(bounds.height).toBeLessThanOrEqual(width === 390 ? 92 : 300);
      if (width === 390) expect(bounds.y + bounds.height).toBeLessThanOrEqual(conversation.y);
      else expect(bounds.x).toBeGreaterThanOrEqual(conversation.x + conversation.width);
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
