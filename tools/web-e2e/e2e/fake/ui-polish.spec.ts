import { expect, test } from "@playwright/test";
import { askingQuestion, workCardScenario, type FakeDaemon } from "@ace/fake-daemon";

for (const theme of ["light", "dark"])
  for (const width of [320, 390, 768, 1440]) {
    test(`theme previews and density remain usable in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme }));
        localStorage.setItem(
          "ace.themes",
          JSON.stringify([
            {
              id: "custom-preview",
              name: "My preview",
              scheme: "light",
              tokens: {
                "--background": "#f0e0d0",
                "--foreground": "#201810",
                "--reading-rgb": "240 224 208",
              },
            },
          ]),
        );
      }, theme);
      await page.goto("/settings/appearance");
      const themes = page.getByRole("radiogroup", { name: "Theme", exact: true });
      await expect(
        themes.getByRole("radio", { name: theme === "light" ? "Light" : "Dark", exact: true }),
      ).toBeChecked();
      const custom = themes.getByRole("radio", { name: "My preview" });
      const preview = custom.locator("[data-theme]");
      expect(await preview.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
        "rgb(240, 224, 208)",
      );
      await custom.click();
      await expect(custom).toBeChecked();
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
        ),
      ).toBe("#f0e0d0");
      const row = page.locator("#appearance\\.density");
      const comfortable = await row.boundingBox();
      await page.getByRole("button", { name: "Compact", exact: true }).click();
      await expect
        .poll(async () => (await row.boundingBox())?.height ?? 0)
        .toBeLessThan(comfortable?.height ?? 0);
      await page.getByRole("button", { name: "Comfortable", exact: true }).click();
      await expect
        .poll(async () => (await row.boundingBox())?.height ?? 0)
        .toBe(comfortable?.height ?? 0);
      await themes.getByRole("radio", { name: "System", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(themes.getByRole("radio", { name: "Light", exact: true })).toBeFocused();
      await expect(themes.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({ path: test.info().outputPath(`appearance-${theme}-${width}.png`) });
      await page.goto("/settings/remote");
      await page.getByRole("button", { name: "Add machine", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add machine", exact: true });
      const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
      const submit = dialog.getByRole("button", { name: "Add machine", exact: true });
      const cancelBox = await cancel.boundingBox();
      const submitBox = await submit.boundingBox();
      const dialogBox = await dialog.boundingBox();
      if (!cancelBox || !submitBox || !dialogBox) throw new Error("Missing modal actions");
      expect(cancelBox.x).toBeLessThan(submitBox.x);
      expect(submitBox.x + submitBox.width).toBeGreaterThan(dialogBox.x + dialogBox.width / 2);
      expect(submitBox.x + submitBox.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: test.info().outputPath(`add-machine-${theme}-${width}.png`) });
      await cancel.click();
      await expect(dialog).toHaveCount(0);
    });
  }

for (const state of ["changes", "failed", "worktree"] as const)
  test(`steady ${state} indicators remain truthful without perpetual CSS drawing`, async ({
    page,
  }) => {
    const fixture = workCardScenario(state);
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
    const toggle = page.getByRole("button", { name: /^Work card/ });
    await expect(toggle).toBeVisible();
    if (state === "changes")
      await expect(toggle).toHaveAccessibleName(/2 agents running.*1 background command/);
    else if (state === "failed") await expect(toggle).toHaveAccessibleName(/Needs you/);
    else await expect(toggle).toHaveAccessibleName("Work card · Nothing pending");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getComputedTiming().iterations === Infinity,
              ).length,
        ),
      )
      .toBe(0);
    await toggle.click();
    const card = page.getByRole("complementary", { name: "Work card" });
    await expect(card.getByRole("button", { name: "Project actions" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`work-${state}.png`) });
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
  });

test("hover and keyboard focus leave question selection visible before Answer", async ({
  page,
}) => {
  const fixture = askingQuestion();
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
  const radio = page.getByRole("radio").first();
  await radio.click();
  await expect(radio).toBeChecked();
  await radio.hover();
  const centreExposesControl = await radio.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === node || (hit !== null && node.contains(hit));
  });
  expect(centreExposesControl).toBe(true);
  await radio.focus();
  await expect(radio).toBeFocused();
  await expect(radio).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("question-selected-hover.png") });
});

// Coarse-pointer visibility must be checked in a browser; jsdom does not compute media rules.
test.describe("touch archive actions", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 900 } });
  test("Restore and Actions are visible without hover and Restore removes the archived row", async ({
    page,
  }) => {
    await page.goto("/");
    const row = page.locator('[data-thread-row="thread-refund-tax"]').getByRole("link");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await page.getByRole("button", { name: /, account$/ }).click();
    await page.getByRole("menuitem", { name: /^Archived threads/ }).click();
    const restore = page.getByRole("button", { name: /^Restore Partial refunds/ });
    await expect(restore).toBeVisible();
    expect(await restore.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
    const actions = page.getByRole("button", { name: /^Actions for Partial refunds/ });
    expect(await actions.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
    await restore.tap();
    await expect(restore).toHaveCount(0);
  });
});

test("an unavailable saved theme shows Dark and keyboard users can Tab into the chooser", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("ace.appearance"))
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: "custom-missing" }));
  });
  await page.goto("/settings/general");
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  const themes = page.getByRole("radiogroup", { name: "Theme", exact: true });
  const dark = themes.getByRole("radio", { name: "Dark", exact: true });
  await expect(dark).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dark).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  const light = themes.getByRole("radio", { name: "Light", exact: true });
  await expect(light).toBeChecked();
  await expect(light).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("ace.appearance") ?? "{}").theme),
    )
    .toBe("light");
  await page.reload();
  await expect(light).toBeChecked();
});

test("a waiting thread keeps its visible Answer status during hover and keyboard focus", async ({
  page,
}) => {
  const fixture = askingQuestion();
  await page.setViewportSize({ width: 1440, height: 900 });
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
  const row = page.getByRole("navigation", { name: "Threads", exact: true }).getByRole("link", {
    name: new RegExp(`^${fixture.thread.title}`),
  });
  const status = row.getByText("Answer", { exact: true });
  await expect(row).toHaveAccessibleName(/Waiting for your answer/);
  await expect(status).toBeVisible();
  await row.hover();
  await expect(status).toBeVisible();
  await page.mouse.move(1400, 800);
  await row.focus();
  await expect(row).toBeFocused();
  await expect(status).toBeVisible();
});
