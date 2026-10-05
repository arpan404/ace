import { expect, type Page } from "@playwright/test";
import { z } from "zod";

const Ordinal = z.coerce.number().int().positive();
const turnCount = 2_000;

/** Await displayed selection after each key, including the initial Home/End. */
export async function selectTurn(page: Page, target: number): Promise<void> {
  Ordinal.parse(target);
  const list = page.getByRole("listbox", { name: "Turns of this thread" });
  const count = page
    .getByRole("heading", { name: "Turns", exact: true })
    .locator("..")
    .locator("span")
    .first();
  await expect(count).toHaveText(/^\d[\d,]*$/);
  await expect(list).toBeFocused();
  const end = target > turnCount / 2;
  await page.keyboard.press(end ? "End" : "Home");
  if (end) {
    await expect
      .poll(async () => {
        const last = Ordinal.parse((await count.textContent())?.replaceAll(",", ""));
        return (await list.getAttribute("aria-activedescendant")) === `turn-option-${last}`;
      })
      .toBe(true);
  } else {
    await expect(list).toHaveAttribute("aria-activedescendant", "turn-option-1");
  }
  let at = Ordinal.parse(
    (await list.getAttribute("aria-activedescendant"))?.replace("turn-option-", ""),
  );
  while (at !== target) {
    const direction = target > at ? 1 : -1;
    const step = Math.abs(target - at) >= 10 ? 10 : 1;
    const key =
      step === 10
        ? direction > 0
          ? "PageDown"
          : "PageUp"
        : direction > 0
          ? "ArrowDown"
          : "ArrowUp";
    await page.keyboard.press(key);
    at += direction * step;
    await expect(list).toHaveAttribute("aria-activedescendant", `turn-option-${at}`);
  }
}

/** Keep the original reading pace, then acknowledge scroll or window movement. */
export async function scrollTranscript(page: Page, delta: number, paceMs: number): Promise<void> {
  const feed = page.getByRole("feed", { name: "Transcript" });
  const viewport = feed.locator("xpath=ancestor::*[@data-virtual-viewport][1]");
  const position = z.object({ top: z.number(), maximum: z.number() }).parse(
    await viewport.evaluate((element) => ({
      top: element.scrollTop,
      maximum: element.scrollHeight - element.clientHeight,
    })),
  );
  const before = await feed.getByRole("article").first().textContent();
  await feed.hover();
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(paceMs);
  if ((delta > 0 && position.top < position.maximum - 1) || (delta < 0 && position.top > 1)) {
    await expect
      .poll(
        async () =>
          (await viewport.evaluate((element) => element.scrollTop)) !== position.top ||
          (await feed.getByRole("article").first().textContent()) !== before,
      )
      .toBe(true);
  }
  await expect(feed).toHaveAttribute("aria-busy", "false");
}

/** A turn key may scroll within a window or replace that window. Acknowledge either. */
export async function stepTurn(page: Page, key: string): Promise<void> {
  const feed = page.getByRole("feed", { name: "Transcript" });
  const viewport = feed.locator("xpath=ancestor::*[@data-virtual-viewport][1]");
  const status = page.getByRole("status", { name: "Jumped" });
  const before = await status.textContent();
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
  await expect
    .poll(
      async () =>
        (await viewport.evaluate((element) => element.scrollTop)) !== top ||
        (await status.count()) === 0 ||
        (await status.textContent()) !== before,
    )
    .toBe(true);
  await expect(feed).toHaveAttribute("aria-busy", "false");
}
