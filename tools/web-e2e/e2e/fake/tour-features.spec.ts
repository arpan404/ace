import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const out = process.env.ACE_SHOTS_DIR ?? "/tmp/ace-orch/shots/fix/tour-broken-features";
mkdirSync(out, { recursive: true });
async function shot(page: Page, name: string, suffix: string) {
  if (!suffix.startsWith("light") && !suffix.startsWith("dark")) return;
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: `${out}/${name}-${suffix}.png`, animations: "disabled" });
}
const cases = ["light", "dark"]
  .flatMap((theme) => [1440, 390].map((width) => ({ theme, width })))
  .concat(
    ["midnight", "graphite", "paper", "slate", "contrast"].map((theme) => ({ theme, width: 390 })),
  );
for (const { theme, width } of cases) {
  const suffix = `${theme}-${width}`;
  test(`tour features remain usable in ${suffix}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((preset) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset }));
      Object.assign(globalThis, { aceFakeWorld: "computer-use" });
    }, theme);
    await page.goto("/t/thread-install-page");
    await page.getByRole("feed", { name: "Transcript" }).waitFor();
    await page.keyboard.press("Control+Shift+m");
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("button", { name: "Enable devices" }).click();
    await panel
      .getByRole("list", { name: "Devices" })
      .getByRole("button", { name: /^iPhone 16 Pro/ })
      .click();
    const phone = panel.getByRole("region", { name: "iPhone 16 Pro" });
    await expect(phone.getByRole("button", { name: "Start live view" })).toBeDisabled();
    await phone.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(phone.getByRole("img", { name: "iPhone 16 Pro screen" })).toBeVisible();
    await phone.getByRole("button", { name: "Device actions" }).click();
    await page.getByRole("menuitem", { name: "Stop live view", exact: true }).click();
    await phone.getByRole("button", { name: "Start live view" }).click();
    await expect(phone.getByRole("img", { name: "iPhone 16 Pro screen" })).toBeVisible();
    await shot(page, "16-device-live", suffix);
    await page.goto("/settings/computer-use");
    const sessions = page.getByRole("list", { name: "Live sessions" });
    await expect(sessions.getByRole("article")).toHaveCount(3);
    await expect(sessions.getByRole("article", { name: "Calculator" })).toContainText(
      "You're in control",
    );
    await sessions.scrollIntoViewIfNeeded();
    await shot(page, "17-computer-settings", suffix);
    if (width === 390)
      await page.getByRole("button", { name: "Back to threads", exact: true }).click();
    await page.getByRole("button", { name: /Computer use is active in 3 apps/ }).click();
    await expect(page.getByRole("button", { name: "Stop Calculator" })).toBeVisible();
    await shot(page, "17-computer-profile", suffix);
    await page.keyboard.press("Escape");
    await page.goto("/new?project=relay");
    const past = page.getByRole("list", { name: "Past sessions in relay" });
    await past.getByRole("button", { name: "Import", exact: true }).first().click();
    await expect(page.getByRole("feed", { name: "Transcript" })).toContainText(
      "The replay cursor advances only after the event is stored.",
    );
    await expect(page.getByText("Starting", { exact: true })).toHaveCount(0);
    const message = page.getByRole("combobox", { name: "Message" });
    await message.fill("Add regression coverage");
    await message.press("Enter");
    await expect(page.getByRole("feed", { name: "Transcript" })).toContainText(
      "Add regression coverage",
    );
    await shot(page, "18-imported-transcript", suffix);
    await page.goto("/skills/engineering~skill~code-review");
    await expect(page.getByRole("heading", { name: "Source", exact: true })).toHaveCount(1);
    await expect(page.getByText(/Review the changes since a fixed point/)).toBeVisible();
    await shot(page, "21-skill-detail", suffix);
    if (width === 390) await page.goto("/skills");
    await page.getByRole("combobox", { name: "Skills project" }).click();
    await page.getByRole("option", { name: "relay", exact: true }).click();
    await page.getByRole("combobox", { name: "Skills provider" }).click();
    await page.getByRole("option", { name: "Claude Code", exact: true }).click();
    const catalog = page.getByRole("navigation", { name: "Skills catalog" });
    await expect(catalog.getByRole("link", { name: "Writing", exact: true })).toBeVisible();
    await expect(catalog.getByRole("link", { name: "Review", exact: true })).toBeVisible();
    await expect(catalog.getByRole("link", { name: "Quality:fix", exact: true })).toBeVisible();
    await shot(page, "21-skills-catalog", suffix);
    await page.goto("/new?project=relay");
    await page.getByRole("combobox", { name: "Message" }).fill("/");
    await expect(page.getByRole("option", { name: /^writing / })).toBeVisible();
    await expect(page.getByRole("option", { name: /^review / })).toBeVisible();
    await expect(page.getByRole("option", { name: /^engineering:code-review / })).toBeVisible();
    await shot(page, "21-slash-catalog", suffix);
    await page.goto("/automations/auto-dependency-audit");
    const runs = page.getByRole("list", { name: "Recent runs" });
    await expect(runs.getByText(/02:00/)).toHaveCount(4);
    await runs.getByRole("button", { name: /Open the run 2 advisories/ }).click();
    const details = page.getByRole("region", { name: "Run details for Nightly dependency audit" });
    await expect(details).toContainText("Scheduled · 4 min");
    await expect(details).not.toContainText(/\d+\/\d+\/\d{4}/);
    await shot(page, "35-automation-times", suffix);
  });
  test(`a fresh first thread finishes in ${suffix}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((preset) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: preset }));
      Object.assign(globalThis, { aceFakeWorld: "empty" });
    }, theme);
    await page.goto("/");
    await page.getByRole("button", { name: "Add a project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add project" });
    await dialog.getByRole("combobox", { name: "Search folders" }).fill("relay");
    await dialog
      .getByRole("option", { name: /^relay/ })
      .first()
      .dblclick();
    const message = page.getByRole("combobox", { name: "Message" });
    await message.fill("Read the project entry points");
    await message.press("Enter");
    await expect(page.getByRole("feed", { name: "Transcript" })).toContainText(
      "I've read the project and identified its entry points.",
    );
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await shot(page, "19-first-thread-finished", suffix);
  });
}
