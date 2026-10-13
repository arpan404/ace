import { expect, test } from "@playwright/test";
import {
  expectActiveTabVisible,
  expectDefaultDiffNoWrap,
  expectIdentifierIntact,
  expectIndependentSplitScroll,
  launchTool,
} from "../../src/work-panel-checks.ts";

for (const theme of ["light", "dark"])
  test(`Work, tab overflow, launcher and split diff stay usable in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(
      (appearance) =>
        localStorage.setItem(
          "ace.appearance",
          JSON.stringify(
            appearance.includes("-")
              ? { theme: appearance.split("-")[0], mode: appearance.split("-")[1] }
              : { mode: appearance },
          ),
        ),
      theme,
    );
    await page.goto("/t/thread-dedupe");
    await page
      .getByRole("heading", { level: 1, name: "Dedupe thread events after reconnect" })
      .waitFor();
    await page.getByRole("button", { name: "Right panel", exact: true }).click();
    const work = page.getByRole("tabpanel", { name: "Work", exact: true });
    await expect(
      work.getByRole("button", { name: "Branch fix/replay-dedupe, switch branch" }),
    ).toBeVisible();
    await expect(page.locator("header [data-work-card-toggle]")).toHaveCount(0);
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Back", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Forward", exact: true }),
    ).toHaveCount(1);
    await expect(work.getByText(/The thread settles when|subagents are still running/)).toHaveCount(
      0,
    );
    await expect(page.getByRole("tab", { name: "Agents", exact: true })).toHaveCount(0);
    await expect(work.getByRole("tree", { name: "Agent tree" })).toBeVisible();
    await expect(
      work.getByText(/Stack membership unavailable|missing or inaccessible/),
    ).toHaveCount(0);
    await expect(work.getByRole("button", { name: /^Pull request #214/ })).toHaveCount(1);
    await expect(work.getByText(/#214/)).toHaveCount(1);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    const tools = page.getByRole("list", { name: "Tools", exact: true });
    await expect(tools).toBeVisible();
    await expect(page.getByRole("heading", { name: "Suggested", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Address", exact: true })).toHaveCount(0);
    await tools.getByRole("button", { name: /^Browser(?: |$)/ }).click();
    await expect(page.getByRole("combobox", { name: "Address", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open a page", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Type an address above|watch them or take over/)).toHaveCount(0);
    for (const tool of ["Preview", "Devices", "Logs"]) await launchTool(page, tool);
    await expectActiveTabVisible(page);
    await page.getByRole("button", { name: "All tabs", exact: true }).click();
    await page.getByRole("menuitem", { name: "Work", exact: true }).click();
    await expectActiveTabVisible(page);
    await page.setViewportSize({ width: 1120, height: 900 });
    await expectActiveTabVisible(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "All tabs", exact: true }).click();
    await page.getByRole("menuitem", { name: "Changes", exact: true }).click();
    await expectDefaultDiffNoWrap(page);
    await expectIdentifierIntact(page, "lastCheckpointSeq");
    await expect(
      page
        .getByRole("tabpanel", { name: "Changes", exact: true })
        .getByRole("region", { name: "Review", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Full view", exact: true }).click();
    await page.getByRole("button", { name: "Diff options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Split", exact: true }).click();
    await expectIndependentSplitScroll(page);
    await page.getByRole("button", { name: "Diff options", exact: true }).click();
    await page
      .getByRole("menuitemcheckbox", { name: "Soft wrap at word boundaries", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expectIdentifierIntact(page, "lastCheckpointSeq");
    await expectIdentifierIntact(page, "COLD_START_WINDOW");
  });
