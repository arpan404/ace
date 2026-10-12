import { test, expect } from "@playwright/test";
import { scrollToRow } from "./thread-list.ts";
import { mkdir } from "node:fs/promises";
import { screenThemes } from "../../src/appearance.ts";

const shots = "/tmp/ace-orch/shots/fix-audit-composer-lifecycle";
const themes = screenThemes;

for (const theme of themes)
  for (const width of [1440, 390]) {
    test(`${theme} at ${width}: new-thread choices stay available and thread context lives in Work without horizontal overflow`, async ({
      page,
    }) => {
      await mkdir(shots, { recursive: true });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((appearance) => {
        localStorage.setItem(
          "ace.appearance",
          JSON.stringify({
            ...(appearance.includes("-")
              ? { theme: appearance.split("-")[0], mode: appearance.split("-")[1] }
              : { mode: appearance }),
            density: "comfortable",
            transcriptSize: "default",
          }),
        );
      }, theme);
      for (const [route, name] of [
        ["/new?project=relay", "new"],
        ["/t/thread-dedupe", "thread"],
      ]) {
        await page.goto(route ?? "/new");
        await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
        const strip = page.getByRole("region", { name: "Where this thread runs" });
        if (name === "new") await expect(strip).toBeVisible();
        else await expect(strip).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (name === "new") {
          await expect(page.getByRole("region", { name: "Past sessions" })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Show all past sessions" })).toHaveCount(0);
          await expect(page.getByText("Loading past sessions…")).toHaveCount(0);
          await expect(page.getByText(/Couldn't load past sessions/)).toHaveCount(0);
        } else await expect(page.getByText(/reconnect-audit found one more path/)).toBeVisible();
        await page.screenshot({ path: `${shots}/${theme}-${width}-${name}.png` });
      }
    });
  }

test("Setup keeps the history dialog and importing reachable away from new thread", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/setup");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Bring an existing conversation").click();
  await page.getByRole("combobox", { name: "Past sessions project" }).click();
  await page.getByRole("option", { name: "relay", exact: true }).click();
  await page.getByRole("button", { name: "Show all past sessions" }).click();
  const dialog = page.getByRole("dialog", { name: "Past sessions" });
  await expect(dialog.getByRole("textbox", { name: "Search past sessions" })).toBeVisible();
  await dialog
    .getByRole("button", { name: /^Import / })
    .first()
    .click();
  await expect(page.getByRole("feed", { name: "Transcript" })).toContainText(
    "The replay cursor advances only after the event is stored.",
  );
  await page.goto("/new?project=relay");
  await expect(page.getByRole("region", { name: "Where this thread runs" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Past sessions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show all past sessions" })).toHaveCount(0);
});

test("failed starts retain three-line row height and recovery text", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      aceFakeSetup: (daemon: { refuseCommands(error: string, type: string): void }) =>
        daemon.refuseCommands("model_unavailable", "thread.create"),
    });
  });
  await page.goto("/new?project=relay");
  await expect(page.getByRole("button", { name: /^Model: Opus/ })).toBeVisible();
  const first = page
    .getByRole("navigation", { name: "Threads", exact: true })
    .getByRole("link", { name: /^Partial refunds/ });
  await expect(first).toBeVisible();
  const firstHeight = (await first.boundingBox())?.height;
  if (firstHeight === undefined) throw new Error("Missing admitted task height");
  await page
    .getByRole("combobox", { name: "Message", exact: true })
    .fill("Recover this failed start");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const started = page
    .getByRole("list", { name: "Starting threads" })
    .getByRole("link", { name: /Recover this failed start/ });
  await scrollToRow(page, started);
  await expect(started).toContainText("Not sent");
  expect((await started.boundingBox())?.height).toBe(firstHeight);
  await page.screenshot({ path: `${shots}/failed-start-1440.png` });
});

test("cold sidebar placeholders occupy the same space as active rows", async ({ page }) => {
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/features/home/home-sidebar.tsx*", async (route) => {
    await barrier;
    await route.continue();
  });
  try {
    await page.goto("/new?project=relay", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status", { name: "Loading threads" })).toBeVisible();
    await expect(page.getByLabel("Loading thread controls")).toBeVisible();
    const placeholders = await page.getByRole("status", { name: "Loading threads" }).boundingBox();
    expect(placeholders?.height).toBe(8 * 84);
    await page.screenshot({ path: `${shots}/cold-sidebar-1440.png` });
  } finally {
    release?.();
  }
  await expect(page.getByRole("navigation", { name: "Threads", exact: true })).toBeVisible();
});
