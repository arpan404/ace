import { expect, type Locator, type Page } from "@playwright/test";

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Missing account control: ${await locator.textContent()}`);
  return box;
}

/** Check the painted controls, including reserved hover actions, against the page edge. */
export async function expectProviderAccountGeometry(page: Page) {
  const list = page.getByRole("list", { name: / accounts$/ });
  if (!(await list.count())) return;
  await page.evaluate(() => document.fonts.ready);
  const model = page.getByRole("button", { name: /^Default model:/ });
  const modelBox = await bounds(model);
  const edge = modelBox.x + modelBox.width;
  for (const control of [
    page.getByRole("button", { name: "Manage", exact: true }),
    page.getByRole("button", {
      name: `Manage ${await page.getByRole("heading", { level: 2 }).textContent()}`,
      exact: true,
    }),
  ]) {
    if (await control.count()) {
      const box = await bounds(control);
      expect(box.x + box.width, "Provider controls share the content edge").toBeCloseTo(edge, 0);
    }
  }
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
      : row.locator("[data-tone]");
    const trailing = [];
    if (await status.count()) trailing.push(status.first());
    if (await action.count()) trailing.push(action);
    if (await menu.count()) trailing.push(menu);
    const before = await Promise.all(trailing.map(bounds));
    const last = before.at(-1);
    if (last)
      expect(last.x + last.width, "Every account ends at the page control edge").toBeCloseTo(
        edge,
        0,
      );
    for (let index = 1; index < before.length; index++) {
      const previous = before[index - 1];
      const current = before[index];
      if (!previous || !current) throw new Error("Missing trailing account control");
      expect(
        current.x - previous.x - previous.width,
        "Status, action and menu have one 8px gap",
      ).toBeCloseTo(8, 0);
      expect(current.y + current.height / 2, "Trailing controls share a line").toBeCloseTo(
        previous.y + previous.height / 2,
        0,
      );
    }
    if (page.viewportSize()?.width === 1440)
      expect((await bounds(row)).height, "Desktop accounts stay one 36px row").toBe(36);
    await row.hover();
    const after = await Promise.all(trailing.map(bounds));
    expect(after, "Revealing hover actions does not move the status or controls").toEqual(before);
  }
  await page.mouse.move(0, 0);
}
