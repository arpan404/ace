import { expect, test, type Page } from "@playwright/test";

/*
 * The model chip's popover in a real browser: it tracks its trigger through pane resizes,
 * and the picker keeps one size while its content changes.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} isn't laid out`);
  return found;
}

async function openPicker(page: Page) {
  await page.goto("/t/thread-replay-cursor");
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("button", { name: /^Change model/ }).click();
  await expect(page.getByRole("combobox", { name: "Search models" })).toBeFocused();
}

test("the model popover stays anchored to the chip with an approval and Files pane", async ({
  page,
}) => {
  await page.goto("/t/thread-refund-tax");
  await page.getByRole("button", { name: "Right panel" }).click();
  await page
    .getByRole("region", { name: "Thread panel" })
    .getByRole("tab", { name: "Files", exact: true })
    .click();
  const chip = page.getByRole("button", { name: /^Model: / });
  await chip.click();
  const anchored = async () => {
    const popup = await box(page, '[data-slot=popover-content][aria-label="Model and effort"]');
    const trigger = await chip.boundingBox();
    if (!trigger) throw new Error("model trigger missing");
    expect(Math.abs(trigger.y - popup.y - popup.height - 8)).toBeLessThanOrEqual(1);
    expect(popup.x).toBeGreaterThanOrEqual(0);
    expect(popup.x + popup.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const column = await box(page, "[data-thread-column]");
    expect(popup.x).toBeGreaterThanOrEqual(column.x);
    expect(popup.x + popup.width).toBeLessThanOrEqual(column.x + column.width);
    expect(trigger.x + trigger.width).toBeGreaterThan(popup.x);
    expect(trigger.x).toBeLessThan(popup.x + popup.width);
  };
  await expect(anchored).toPass();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(anchored).toPass();
});

test("the picker keeps its size and its search in place across tabs, a search and a star", async ({
  page,
}) => {
  await openPicker(page);
  const panel = "[data-slot=model-picker]";
  const search = page.getByRole("combobox", { name: "Search models" });
  const first = await box(page, panel);
  expect(first.width).toBeLessThanOrEqual(360);
  expect(first.height).toBeLessThanOrEqual(360);
  await expect(page.getByRole("tablist", { name: "Model sources" })).toHaveCSS(
    "overflow-y",
    "auto",
  );
  await expect(page.getByRole("listbox", { name: "Models" })).toHaveCSS("overflow-y", "auto");
  const firstSearch = await search.boundingBox();
  const same = async () => {
    expect(await box(page, panel)).toEqual(first);
    expect(await search.boundingBox()).toEqual(firstSearch);
  };

  await page.getByRole("tab", { name: "Codex · Personal", exact: true }).click();
  await same();
  await search.fill("sonnet");
  await same();
  await search.fill("no model is called this");
  await expect(page.getByText("No models match")).toBeVisible();
  await same();
  await search.fill("");
  await page.getByRole("tab", { name: "Favorites" }).click();
  await expect(page.getByText("No favorites yet")).toBeVisible();
  await same();
  await page.getByRole("tab", { name: "Claude Code · Work", exact: true }).click();
  await page.getByRole("option", { name: "Haiku 4.5, Claude Code" }).hover();
  await page.getByRole("button", { name: "Add Haiku 4.5 to favorites" }).click();
  await page.getByRole("tab", { name: "Favorites" }).click();
  await expect(page.getByRole("option", { name: "Haiku 4.5, Claude Code" })).toBeVisible();
  await same();
});

test("reasoning and Fast indicators stay visible and own their hover tooltip on a narrow composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/new");
  const chip = page.getByRole("button", { name: /^Model: / });
  await chip.click();
  const popup = page.getByRole("dialog", { name: "Model and effort" });
  await popup.getByRole("button", { name: /^Change model/ }).click();
  await popup.getByRole("tab", { name: "Codex · Personal", exact: true }).click();
  await popup.getByRole("option", { name: /^GPT-6\.1 Sol,/ }).click();
  await popup.getByRole("button", { name: "Fast mode", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  const signal = chip.getByRole("img", { name: /reasoning/ });
  const fast = chip.getByRole("img", { name: "Fast: on" });
  await expect(signal).toBeVisible();
  await expect(fast).toBeVisible();
  await expect(signal).toHaveText("·Med");
  const indicatorWidths = [await signal.boundingBox(), await fast.boundingBox()].map(
    (bounds) => bounds?.width,
  );
  // Constrain the control as a narrow split pane would: only the model name yields space.
  await chip.evaluate((element) => {
    element.style.maxWidth = "160px";
  });
  const name = chip.locator('[data-slot="model-name"]');
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(
    [await signal.boundingBox(), await fast.boundingBox()].map((bounds) => bounds?.width),
  ).toEqual(indicatorWidths);
  const chipBox = await chip.boundingBox();
  if (!chipBox) throw new Error("model chip missing");
  for (const indicator of [signal, fast]) {
    const bounds = await indicator.boundingBox();
    if (!bounds) throw new Error("indicator missing");
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(chipBox.x + chipBox.width);
  }
  await chip.evaluate((element) => {
    element.style.maxWidth = "";
  });
  for (const indicator of [signal, fast]) {
    await indicator.hover();
    await expect(page.getByRole("tooltip")).toHaveCount(1);
    await expect(page.getByRole("tooltip")).toHaveText(
      (await indicator.getAttribute("aria-label")) ?? "",
    );
    await indicator.click();
    await expect(popup).toBeVisible();
    // The popup initially focuses Fast, whose tooltip is legitimate. Focus the slider before Escape.
    await popup.getByRole("slider", { name: "Effort" }).focus();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  await page
    .locator('[data-slot="composer"]')
    .screenshot({ path: "/tmp/ace-model-signal-phone.png" });
});

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`reasoning picker uses supported choices in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(
        (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
        theme,
      );
      await page.goto("/new");
      const chip = page.getByRole("button", { name: /^Model: / });
      await expect(chip).toHaveCSS("font-size", "12.5px");
      await chip.click();
      const popup = page.getByRole("dialog", { name: "Model and effort" });
      const group = popup.getByRole("slider", { name: "Effort" });
      await expect(group).toBeVisible();
      await expect(popup.getByRole("radiogroup")).toHaveCount(0);
      await group.focus();
      await page.keyboard.press("End");
      await expect(group).toHaveAttribute("aria-valuetext", "High");
      await expect(popup.getByText("High", { exact: true })).toBeVisible();
      const bounds = await popup.boundingBox();
      if (!bounds) throw new Error("picker missing");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await popup.screenshot({
        animations: "disabled",
        path: `/tmp/ace-reasoning-picker-${theme}-${width}.png`,
      });
    });

for (const width of [1440, 360])
  test(`compact catalog scrolls vertically without horizontal tracks at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/new");
    await page.getByRole("button", { name: /^Model: / }).click();
    const popup = page.getByRole("dialog", { name: "Model and effort" });
    await popup.getByRole("button", { name: /^Change model/ }).click();
    const rail = popup.getByRole("tablist", { name: "Model sources" });
    const list = popup.getByRole("listbox", { name: "Models" });
    for (const scroll of [rail, list]) {
      await expect(scroll).toHaveCSS("overflow-x", "hidden");
      await expect(scroll).toHaveCSS("overflow-y", "auto");
      await expect(scroll).toHaveCSS("scrollbar-width", "none");
      expect(await scroll.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    }
    const railBounds = await rail.boundingBox();
    if (!railBounds) throw new Error("provider rail missing");
    for (const mark of await rail.getByRole("img").all()) {
      const bounds = await mark.boundingBox();
      if (!bounds) continue;
      expect(bounds.x).toBeGreaterThanOrEqual(railBounds.x + 2);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(railBounds.x + railBounds.width - 2);
    }
    await popup.getByRole("combobox", { name: "Search models" }).fill("o");
    await expect
      .poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const scrollable = await list.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    );
    expect(scrollable).toBe(true);
    await list.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await popup.screenshot({
      animations: "disabled",
      path: `/tmp/ace-compact-catalog-${width}.png`,
    });
  });

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`explicit Ultra animates only the contained slider in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(
        (chosen) =>
          localStorage.setItem(
            "ace.appearance",
            JSON.stringify({ theme: chosen, accent: "custom", customAccent: "#06b6d4" }),
          ),
        theme,
      );
      await page.goto("/t/thread-ultra-reasoning-preview?fakeWorld=thread-activity");
      const chip = page.getByRole("button", { name: /^Model: / });
      const reasoning = chip.getByRole("img", { name: "Ultra reasoning" });
      await expect(reasoning).toHaveText("·Ultra");
      await expect(reasoning).toHaveCSS("animation-name", "none");
      await expect(chip.getByRole("img", { name: "Fast: on" })).toBeVisible();
      await chip.click();
      const popup = page.getByRole("dialog", { name: "Model and effort" });
      const slider = popup.getByRole("slider", { name: "Effort" });
      await expect(slider).toHaveAttribute("aria-valuetext", "Ultra");
      const accentText = await slider.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ring-text)";
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(popup.getByText("Ultra", { exact: true })).toHaveCSS("color", accentText);
      await expect(reasoning.getByText("Ultra", { exact: true })).toHaveCSS("color", accentText);
      const convergence = slider.locator(".step-slider-convergence");
      await expect(convergence).toBeVisible();
      await expect(convergence).toHaveCSS("overflow", "hidden");
      const stream = convergence.locator("span").first();
      const initialStream = await stream.evaluate((element) => getComputedStyle(element).transform);
      const initial = await convergence.evaluate(
        (element) => getComputedStyle(element, "::before").transform,
      );
      for (const frame of [0, 1, 2]) {
        if (frame) await page.waitForTimeout(2750);
        await popup.screenshot({
          path: `/tmp/ace-ultra-accent-${theme}-${width}-${frame}.png`,
        });
      }
      expect(
        await convergence.evaluate((element) => getComputedStyle(element, "::before").transform),
      ).not.toBe(initial);
      expect(await stream.evaluate((element) => getComputedStyle(element).transform)).not.toBe(
        initialStream,
      );
      const bounds = await popup.boundingBox();
      if (!bounds) throw new Error("Ultra picker missing");
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await convergence.evaluate(
          (element) => getComputedStyle(element, "::before").animationName,
        ),
      ).toBe("none");
      for (const filament of await convergence.locator("span").all())
        await expect(filament).toHaveCSS("animation-name", "none");
      await slider.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(slider).toHaveAttribute("aria-valuetext", "High");
      await expect(convergence).toHaveCount(0);
      await expect(popup.getByText("High", { exact: true })).toHaveCSS("animation-name", "none");
      await expect(chip.getByRole("img", { name: "High reasoning" })).toHaveText("·High");
    });

test("an unknown effort is neutral until an actual supported stop is chosen, and reset unsets it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/t/thread-dedupe");
  const chip = page.getByRole("button", { name: /^Model: / });
  await expect(chip.getByRole("img", { name: /reasoning/ })).toHaveCount(0);
  await chip.click();
  const popup = page.getByRole("dialog", { name: "Model and effort" });
  const slider = popup.getByRole("slider", { name: "Effort" });
  await expect(popup.getByText("Choose effort", { exact: true })).toBeVisible();
  await expect(popup.getByText("Default", { exact: true })).toHaveCount(0);
  await expect(slider).toHaveAttribute("aria-valuetext", "Choose effort");
  await popup.screenshot({ animations: "disabled", path: "/tmp/ace-effort-unselected-390.png" });
  await slider.click({ position: { x: 13, y: 11 } });
  await expect(slider).toHaveAttribute("aria-valuetext", "Low");
  await expect(chip.getByRole("img", { name: "Low reasoning" })).toHaveText("·Low");
  await popup.getByRole("button", { name: "Reset effort and speed" }).click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Choose effort");
  await expect(chip.getByRole("img", { name: /reasoning/ })).toHaveCount(0);
});

test("dragging effort outside the track never selects page text or leaves a stuck drag", async ({
  page,
}) => {
  await page.goto("/t/thread-ultra-reasoning-preview?fakeWorld=thread-activity");
  await page.getByRole("button", { name: /^Model: / }).click();
  const popup = page.getByRole("dialog", { name: "Model and effort" });
  const slider = popup.getByRole("slider", { name: "Effort" });
  const bounds = await slider.boundingBox();
  if (!bounds) throw new Error("Effort track missing");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 100, bounds.y - 150, { steps: 10 });
  await expect(slider).toHaveAttribute("aria-valuetext", "Minimal");
  await page.mouse.move(bounds.x + bounds.width + 160, bounds.y + 180, { steps: 10 });
  await expect(slider).toHaveAttribute("aria-valuetext", "Ultra");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.mouse.up();
  await expect(slider).not.toHaveAttribute("data-dragging");
  await expect(slider).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await popup.getByRole("button", { name: /^Change model/ }).click();
  await expect(popup.getByRole("combobox", { name: "Search models" })).toBeFocused();
});

for (const route of ["/new", "/t/thread-replay-cursor"])
  for (const width of [1440, 390])
    test(`permission trigger shows the selection without crowding the model on ${route} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(route);
      await page.getByRole("button", { name: /^Approvals:/ }).click();
      await page.getByRole("menuitemradio", { name: "Full access", exact: true }).click();
      const trigger = page.getByRole("button", { name: /^Approvals: Full access/ });
      await expect(trigger).toHaveText("Full access");
      const colors = await trigger.evaluate((element) => {
        const actual = getComputedStyle(element).color;
        const probe = document.createElement("span");
        probe.style.color = "var(--status-needs-you)";
        element.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return { actual, expected };
      });
      await expect(trigger).toHaveCSS("color", colors.expected);
      const bounds = await trigger.boundingBox();
      const model = await page.getByRole("button", { name: /^Model: / }).boundingBox();
      if (!bounds || !model) throw new Error("composer controls missing");
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(model.x);
      expect(model.x + model.width).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await page.locator('[data-slot="composer"]').screenshot({
        path: `/tmp/ace-permission-label-${route === "/new" ? "new" : "thread"}-${width}.png`,
      });
      await trigger.click();
      await page.getByRole("menuitemradio", { name: "Manual", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Approvals: Manual/ })).toHaveText("Manual");
    });

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`new thread setup sits above its composer and preserves worktree choices in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(
        (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
        theme,
      );
      await page.goto("/new?project=relay");
      const setup = page.getByRole("region", { name: "Where this thread runs" });
      const composer = page.locator('[data-slot="composer"]');
      await expect(setup).toBeVisible();
      const frame = await setup.boundingBox();
      const input = await composer.boundingBox();
      if (!frame || !input) throw new Error("new thread setup missing");
      expect(frame.y).toBeLessThan(input.y);
      await expect
        .poll(async () => {
          const currentSetup = await setup.boundingBox();
          const currentInput = await composer.boundingBox();
          return currentSetup && currentInput
            ? currentSetup.y + currentSetup.height - currentInput.y
            : Infinity;
        })
        .toBeLessThanOrEqual(17);
      await expect(page.getByRole("heading", { level: 2 })).toHaveText(
        /What should we work on in\s+relay\s*\?/,
      );
      await expect(page.getByRole("button", { name: /^Import/ })).toHaveCount(0);
      const message = composer.getByRole("combobox", { name: "Message" });
      await message.fill("Keep this draft while changing project");
      const rowControl =
        width < 480
          ? setup.getByRole("button", { name: "Environment", exact: true })
          : setup.getByRole("checkbox", { name: "Worktree" });
      await expect
        .poll(async () => {
          const region = await setup.boundingBox();
          const control = await rowControl.boundingBox();
          return region && control ? control.y - region.y : 0;
        })
        .toBeGreaterThanOrEqual(5);
      const compact = width < 480;
      if (compact) await setup.getByRole("button", { name: "Environment", exact: true }).click();
      const controls = compact
        ? page.getByRole("dialog", { name: "Environment", exact: true })
        : setup;
      await expect(
        page.getByRole("heading", { level: 2 }).getByRole("button", { name: "Project: relay" }),
      ).toBeVisible();
      const toggle = controls.getByRole("checkbox", { name: "Worktree" });
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(controls.getByRole("button", { name: /^Start from:/ })).toHaveCount(0);
      await toggle.click();
      await controls.getByRole("button", { name: /^Start from:/ }).click();
      const branch = page.getByRole("dialog", { name: "Start from a branch" });
      await branch.getByRole("combobox", { name: "Start from branch" }).fill("dev");
      await branch.getByRole("option", { name: /^develop/ }).click();
      if (compact && !(await controls.isVisible()))
        await setup.getByRole("button", { name: "Environment", exact: true }).click();
      await expect(controls.getByRole("button", { name: "Start from: develop" })).toBeVisible();
      if (compact) await composer.getByRole("combobox", { name: "Message" }).click();
      await page
        .getByRole("heading", { level: 2 })
        .getByRole("button", { name: "Project: relay" })
        .click();
      await page.getByRole("menuitemradio", { name: "ace", exact: true }).click();
      if (compact && !(await controls.isVisible()))
        await setup.getByRole("button", { name: "Environment", exact: true }).click();
      await expect(
        page.getByRole("heading", { level: 2 }).getByRole("button", { name: "Project: ace" }),
      ).toBeVisible();
      await expect(message).toHaveText("Keep this draft while changing project");
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      if (compact) {
        await composer.getByRole("combobox", { name: "Message" }).click();
        await expect(controls).toBeHidden();
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await page.screenshot({ path: `/tmp/ace-new-thread-context-top-${theme}-${width}.png` });
    });

for (const theme of ["light", "dark"]) {
  for (const route of ["/new?project=relay", "/t/thread-dedupe?fakeWorld=thread-activity"]) {
    test(`empty caret starts before its placeholder in ${theme} on ${route}`, async ({ page }) => {
      await page.addInitScript(
        (t) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: t })),
        theme,
      );
      await page.goto(route);
      const input = page.getByRole("combobox", { name: "Message", exact: true });
      await input.fill("");
      const bounds = await input.boundingBox();
      if (!bounds) throw new Error("Message isn't laid out");
      await input.click({ position: { x: bounds.width - 5, y: 10 } });
      expect(
        await input.evaluate((el) => {
          const selection = getSelection();
          return {
            text: el.textContent,
            offset: selection?.focusOffset,
            collapsed: selection?.isCollapsed,
          };
        }),
      ).toEqual({ text: "", offset: 0, collapsed: true });
      await page.keyboard.type("x");
      await expect(input).toHaveText("x");
      expect(
        await input.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect().left - el.getBoundingClientRect().left;
        }),
      ).toBeLessThanOrEqual(1);
      await page.keyboard.press("Backspace");
      await expect(input).toHaveAttribute("data-empty", "true");
      await input.click({ position: { x: bounds.width - 5, y: 10 } });
      expect(await input.evaluate(() => getSelection()?.focusOffset)).toBe(0);
      await page.keyboard.type(" ");
      await expect(input).not.toHaveAttribute("data-empty", "true");
      await page.keyboard.press("Backspace");
      await expect(input).toHaveAttribute("data-empty", "true");
    });
  }
}
