import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`composer stays multiline and caps pasted wrapped text at seven lines in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.addInitScript(
        (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
        theme,
      );
      await page.goto("/t/thread-refund-tax");
      const composer = page.locator('[data-slot="composer"]');
      const input = page.getByRole("combobox", { name: "Message", exact: true });
      const add = composer.getByRole("button", { name: "Add files and context" });
      const send = composer.getByRole("button", { name: "Send", exact: true });
      await input.focus();
      await expect(async () => {
        const editor = await input.boundingBox(),
          left = await add.boundingBox(),
          right = await send.boundingBox();
        if (!editor || !left || !right) throw new Error("composer missing");
        expect(editor.y + editor.height).toBeLessThanOrEqual(left.y + 1);
        expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
        expect(left.x + left.width).toBeLessThan(right.x);
        expect(editor.width).toBeGreaterThan(50);
      }).toPass();
      const pasted = "Preserve every word of this wrapped draft and its retry details. ".repeat(
        120,
      );
      await input.fill(pasted);
      await expect(input).toHaveText(pasted);
      await expect(async () => {
        const size = await input.evaluate((element) => ({
          height: element.clientHeight,
          scroll: element.scrollHeight,
        }));
        expect(size.height).toBe(160);
        expect(size.scroll).toBeGreaterThan(size.height);
      }).toPass();
      await input.press("ControlOrMeta+End");
      await input.press("!");
      await expect(input).toHaveText(pasted + "!");
      await input.fill("");
      await expect(input).toHaveCSS("height", "40px");
      await expect
        .poll(() => input.evaluate((element) => getComputedStyle(element, "::before").content))
        .toContain("Ask anything");
      await page.getByLabel("Files to attach").setInputFiles({
        name: "trace.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("retry trace"),
      });
      await page.getByRole("button", { name: /Remove trace.txt/ }).click();
      const environment = page.getByRole("region", { name: "Environment", exact: true });
      await expect(environment.getByRole("button", { name: /^Model: / })).toBeVisible();
      await expect(environment.getByRole("button", { name: /^Environment:/ })).toHaveCSS(
        "height",
        "28px",
      );
      await expect(composer.getByRole("button", { name: /^Model: / })).toHaveCount(0);
      await expect(composer.getByRole("button", { name: /^Approvals:/ })).toBeVisible();
      await page.locator("[data-composer-dock]").screenshot({
        animations: "disabled",
        path: `/tmp/ace-multiline-composer-${theme}-${width}.png`,
      });
    });

for (const theme of ["light", "dark"])
  test(`the composer and both attached panels share one glass tint in ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (chosen) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen })),
      theme,
    );
    await page.goto("/t/thread-refund-tax");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    const dock = page.locator("[data-composer-dock]");
    const surfaces = dock.locator(".glass");
    await expect(surfaces).toHaveCount(3);
    await expect(async () => {
      const materials = await surfaces.evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            filter: style.backdropFilter,
            shadow: style.boxShadow,
          };
        }),
      );
      expect(new Set(materials.map((surface) => surface.background)).size).toBe(1);
      expect(new Set(materials.map((surface) => surface.filter)).size).toBe(1);
      expect(materials[0]?.background).toMatch(/^rgba\(/);
      // Only inset highlight and zero-blur edge; no cast shadow can tint another panel.
      expect(
        materials.every(
          (surface) => !surface.shadow.includes("24px") && !surface.shadow.includes("40px"),
        ),
      ).toBe(true);
    }).toPass();
    await page.getByRole("heading", { level: 1 }).focus();
    await dock.screenshot({
      animations: "disabled",
      path: `/tmp/ace-composer-shared-glass-${theme}-blank.png`,
    });
    await page.locator("[data-thread-column]").evaluate((element) => {
      element.style.backgroundImage = "linear-gradient(110deg, #4777cb, #ca7d53)";
    });
    await page.locator("[data-thread-column] [data-virtual-viewport]").evaluate((element) => {
      element.scrollTop = 0;
    });
    await dock.screenshot({
      animations: "disabled",
      path: `/tmp/ace-composer-shared-glass-${theme}-colour.png`,
    });
  });

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`composer floats above scrollable text with an attached environment in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.addInitScript((chosen) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen }));
      }, theme);
      await page.goto("/t/thread-refund-tax");
      const composer = page.locator('[data-slot="composer"]');
      const environment = page.getByRole("region", { name: "Environment", exact: true });
      await expect(environment).toBeVisible();
      await expect(async () => {
        const shell = await composer.boundingBox();
        const panel = await environment.boundingBox();
        const viewport = await page
          .locator("[data-thread-column] [data-virtual-viewport]")
          .boundingBox();
        if (!shell || !panel || !viewport) throw new Error("composer layout missing");
        expect(panel.x).toBe(shell.x + 16);
        expect(panel.y).toBe(shell.y + shell.height - 16);
        expect(panel.width).toBe(shell.width - 32);
        expect(viewport.y + viewport.height).toBeGreaterThan(panel.y + panel.height);
        const glass = await composer.evaluate((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, blur: style.backdropFilter };
        });
        expect(glass.background).toMatch(/rgba\(.+, 0\.\d+\)/);
        expect(glass.blur).toContain("blur(");
      }).toPass();
      // Transparency is optional: the OS preference must restore an opaque readable surface.
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
      });
      await expect(async () => {
        expect(await composer.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe(
          "none",
        );
        expect(
          await composer.evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toMatch(/^rgb\(/);
      }).toPass();
    });

test("composer growth keeps live content above the deck and preserves an older reading position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await page.goto("/t/thread-refund-tax");
  const viewport = page.locator("[data-thread-column] [data-virtual-viewport]");
  const message = page.getByRole("combobox", { name: "Message", exact: true });
  const endGap = () =>
    viewport.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(endGap).toBeLessThanOrEqual(1);
  await message.fill("Check the retries\nPreserve the request\nKeep the logs\nVerify the result");
  await expect.poll(endGap).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1200, height: 500 });
  await expect.poll(endGap).toBeLessThanOrEqual(1);
  await expect(async () => {
    const feed = await page.getByRole("feed", { name: "Transcript" }).boundingBox();
    const deck = await page.locator("[data-composer-dock]").boundingBox();
    if (!feed || !deck) throw new Error("transcript layout missing");
    expect(feed.y + feed.height).toBeLessThanOrEqual(deck.y);
  }).toPass();
  // Wait out the initial automatic glide before acting as a reader scrolling into history.
  await expect(async () => {
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.getByRole("button", { name: /^Jump to live/ })).toBeVisible();
  }).toPass();
  await message.fill(
    "A longer draft\nMore context\nAnother line\nKeep going\nStill reading history\nFinal detail",
  );
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await page.setViewportSize({ width: 1100, height: 500 });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(async () => {
    const deck = await page.locator("[data-composer-dock]").boundingBox();
    const jump = await page.getByRole("button", { name: /^Jump to live/ }).boundingBox();
    if (!deck || !jump) throw new Error("jump layout missing");
    const view = await viewport.boundingBox();
    if (!view) throw new Error("viewport missing");
    expect(jump.y).toBeGreaterThanOrEqual(view.y);
    expect(jump.y + jump.height).toBeLessThanOrEqual(Math.max(deck.y, view.y + 44) + 1);
  }).toPass();
  await page.getByRole("button", { name: /^Jump to live/ }).click();
  await expect.poll(endGap).toBeLessThanOrEqual(1);
});
