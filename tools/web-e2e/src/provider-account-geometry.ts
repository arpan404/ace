import { expect, type Locator, type Page } from "@playwright/test";

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Missing account control: ${await locator.textContent()}`);
  return box;
}

async function painted(locator: Locator) {
  if (!(await locator.count())) return false;
  return locator.evaluate((element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.opacity === "0" || style.visibility === "hidden" || style.display === "none")
        return false;
    }
    return true;
  });
}

/** Read the actual Update button, rather than an invisible account action or menu slot. */
export async function providerActionEdge(page: Page) {
  const update = await bounds(page.getByRole("button", { name: "Update", exact: true }));
  return update.x + update.width;
}

/** Every account's last painted reading or action shares Update's right edge. */
export async function expectProviderAccountGeometry(page: Page, edge: number) {
  const list = page.getByRole("list", { name: / accounts$/ });
  if (!(await list.count())) return;
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  for (const row of await list.getByRole("listitem").all()) {
    const badge = row.getByRole("img", { name: / account$/ });
    if (!(await badge.count())) continue;
    const menu = row.getByRole("button", { name: /^Manage / });
    const action = row.getByRole("button", { name: /^(Sign in|Reconnect|Make default)$/ });
    expect(
      await action.count(),
      "Each account has at most one trailing action",
    ).toBeLessThanOrEqual(1);
    const meter = row.getByRole("meter");
    const status = (await meter.count())
      ? row.getByText(`${await meter.getAttribute("aria-valuenow")}%`, { exact: true })
      : row.locator("[data-tone]").or(row.getByText(/ · Not reported yet$/));
    const reading = status.first();
    await expect(reading, "Every account reports a status or quota reading").toHaveCount(1);
    const controls = [reading];
    if (await action.count()) controls.push(action);
    if (await menu.count()) controls.push(menu);
    const before = await Promise.all(controls.map(bounds));
    const aligned = async () => {
      const last = (await painted(action)) ? action : reading;
      expect(await painted(last), "The trailing element is painted").toBe(true);
      const box = await bounds(last);
      expect(
        Math.abs(box.x + box.width - edge),
        "Last visible account element ends at Update",
      ).toBeLessThanOrEqual(2);
      if (await menu.count()) {
        const menuBox = await bounds(menu);
        expect(
          menuBox.x - box.x - box.width,
          "Only the fixed menu slot follows the visible element",
        ).toBeCloseTo(8, 0);
        expect(menuBox.y + menuBox.height / 2, "Trailing controls share a line").toBeCloseTo(
          box.y + box.height / 2,
          0,
        );
      }
    };
    await aligned();
    if (page.viewportSize()?.width === 1440)
      expect((await bounds(row)).height, "Desktop accounts stay one 36px row").toBe(36);
    await row.hover();
    await aligned();
    expect(await Promise.all(controls.map(bounds)), "Hover changes no account geometry").toEqual(
      before,
    );
    await page.mouse.move(0, 0);
    if (await action.count()) {
      await action.focus();
      await aligned();
      expect(
        await Promise.all(controls.map(bounds)),
        "Focusing an action changes no account geometry",
      ).toEqual(before);
      await action.evaluate((element) => element.blur());
    }
    if (await menu.count()) {
      await menu.focus();
      await aligned();
      expect(
        await Promise.all(controls.map(bounds)),
        "Keyboard focus changes no account geometry",
      ).toEqual(before);
      await menu.evaluate((element) => element.blur());
    }
    await page.mouse.move(0, 0);
  }
}
