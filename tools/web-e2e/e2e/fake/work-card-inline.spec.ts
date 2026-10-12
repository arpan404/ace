import { expect, test } from "@playwright/test";
import { workCardScenario, type FakeDaemon } from "@ace/fake-daemon";

for (const theme of ["light", "dark"])
  for (const width of [1440, 390, 320]) {
    test(`Work preserves the conversation draft in ${theme} at ${width}`, async ({ page }) => {
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
      await input.fill("Keep this draft while opening Work");
      if (width >= 640)
        await page.getByRole("button", { name: "Right panel", exact: true }).click();
      else {
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Work", exact: true }).click();
      }
      const work = page.getByRole("tabpanel", { name: "Work", exact: true });
      await expect(work.getByRole("button", { name: "Project actions" })).toBeVisible();
      const command = work.getByRole("button", { name: "Show bun run dev output" });
      await command.scrollIntoViewIfNeeded();
      await expect(command).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      if (width >= 640)
        await page.getByRole("button", { name: "Right panel", exact: true }).click();
      else await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect(work).toBeHidden();
      await expect(input).toHaveText("Keep this draft while opening Work");
    });
  }

for (const height of [220, 320]) {
  test(`Work's last automation action can be scrolled into view in a ${height}px window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height });
    await page.goto("/t/thread-dedupe");
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Work", exact: true }).click();
    const action = page
      .getByRole("tabpanel", { name: "Work", exact: true })
      .getByRole("switch", { name: "Enable Changelog draft" });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 1 });
    await action.click();
    await expect(action).toBeChecked();
  });
}
