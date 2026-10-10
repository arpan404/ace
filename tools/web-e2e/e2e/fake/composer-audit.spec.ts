import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const shots = "/tmp/ace-orch/shots/fix-audit-composer-lifecycle";
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];

for (const theme of themes)
  for (const width of [1440, 390]) {
    test(`${theme} at ${width}: environment stays below the composer without horizontal overflow`, async ({
      page,
    }) => {
      await mkdir(shots, { recursive: true });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((appearance) => {
        localStorage.setItem(
          "ace.appearance",
          JSON.stringify({
            theme: appearance,
            accent: "theme",
            customAccent: "#7AA2F7",
            glass: 1,
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
        await expect(strip).toBeVisible();
        const environment = await strip.boundingBox();
        const input = await page
          .getByRole("combobox", { name: "Message", exact: true })
          .boundingBox();
        expect(environment && input && environment.y > input.y + input.height).toBeTruthy();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (name === "new")
          await expect(page.getByRole("button", { name: "Show all past sessions" })).toBeVisible();
        else await expect(page.getByText(/reconnect-audit found one more path/)).toBeVisible();
        await page.screenshot({ path: `${shots}/${theme}-${width}-${name}.png` });
      }
    });
  }

test("failed starts retain three-line row height and recovery text", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      aceFakeSetup: (daemon: { refuseCommands(error: string, type: string): void }) =>
        daemon.refuseCommands("model_unavailable", "thread.create"),
    });
  });
  await page.goto("/new?project=relay");
  await expect(page.getByRole("button", { name: /^Model: Opus/ })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Message", exact: true })
    .fill("Recover this failed start");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const started = page
    .getByRole("list", { name: "Starting threads" })
    .getByRole("link", { name: /Recover this failed start/ });
  await expect(started).toContainText("Not sent");
  const first = page
    .getByRole("navigation", { name: "Threads", exact: true })
    .getByRole("link", { name: /^Partial refunds/ });
  expect((await started.boundingBox())?.height).toBe((await first.boundingBox())?.height);
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
    expect(placeholders?.height).toBe(8 * 80);
    await page.screenshot({ path: `${shots}/cold-sidebar-1440.png` });
  } finally {
    release?.();
  }
  await expect(page.getByRole("navigation", { name: "Threads", exact: true })).toBeVisible();
});
