import type { ComponentCapture } from "./component-polish-capture.ts";
import { expectReady } from "./component-polish-capture.ts";

export async function captureThreadExtras({ page, width, go, capture }: ComponentCapture) {
  const command = async (name: string) => {
    await page.keyboard.press("Meta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill(name);
    await page
      .getByRole("option", { name: new RegExp(`^${name}`) })
      .first()
      .click();
  };
  await go("/t/thread-cold-start");
  await expectReady(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
  await capture("composer-busy-typed", async () => {
    await go("/t/thread-install-page");
    await page
      .getByRole("combobox", { name: "Message", exact: true })
      .fill("Also add the troubleshooting example.");
  });
  await capture("composer-queued", async () => {
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await expectReady(page.getByText("Queued", { exact: true })).toBeVisible();
  });
  await capture("composer-mention-chip", async () => {
    await go("/t/thread-ux-auth-error");
    await page.getByRole("combobox", { name: "Message", exact: true }).fill("@read");
    await page.getByRole("option", { name: /README.md/ }).click();
  });
  await capture("plan-expanded", async () => {
    await go("/t/thread-install-page");
    await page.getByRole("button", { name: /plan/i }).first().click();
  });
  await capture("handoff-expanded", async () => {
    await go("/t/thread-ux-switch-handoff");
    await page.getByRole("button", { name: "What the agent received" }).click();
  });
  await capture("failed-commands", async () => {
    await go("/t/thread-ux-failed-commands");
    await page
      .getByRole("button", { name: /^Worked for/ })
      .first()
      .click();
    await expectReady(page.getByText("Failed", { exact: true })).toBeVisible();
  });
  await capture("subagents", async () => {
    await go("/t/thread-settings");
    await page
      .getByRole("button", { name: /Subagent|agent.*finished/i })
      .first()
      .click();
  });
  await capture("background-task", async () => {
    await go("/t/thread-fan-out");
  });
  await capture("error-details", async () => {
    await go("/t/thread-ux-auth-error");
    await page
      .getByRole("button", { name: /Details/ })
      .first()
      .click();
  });
  await capture("find-filters", async () => {
    await go("/t/thread-cold-start");
    await command("Search this thread");
  });
  await capture("turns-index", async () => {
    await go("/t/thread-multi-day");
    await command("Turns");
  });
  for (const tool of [
    "Files",
    "Agents",
    "Terminal",
    "Logs",
    "Devices",
    "Computer use",
    "Preview",
  ]) {
    await capture(`panel-${tool.toLowerCase().replaceAll(" ", "-")}`, async () => {
      await go("/t/thread-cold-start");
      await page.keyboard.press("Meta+Shift+d");
      const panel = page.getByRole("region", { name: "Thread panel", exact: true });
      await expectReady(panel).toBeVisible();
      await panel.getByRole("button", { name: "New tab", exact: true }).click();
      await page
        .getByRole("list", { name: "Tools", exact: true })
        .getByRole("button", { name: new RegExp(`^${tool}`) })
        .click();
      await expectReady(panel.getByRole("tab", { selected: true })).toContainText(
        tool === "Preview" ? "web" : tool,
      );
      await expectReady(panel.getByRole("status", { name: "Loading", exact: true })).toHaveCount(0);
      if (tool === "Preview")
        await expectReady(panel.getByRole("button", { name: "Retry", exact: true })).toBeVisible({
          timeout: 15000,
        });
    });
  }
  await capture("panel-launcher", async () => {
    const panel = page.getByRole("region", { name: "Thread panel", exact: true });
    await panel.getByRole("button", { name: "New tab", exact: true }).click();
    await expectReady(page.getByRole("list", { name: "Tools", exact: true })).toBeVisible();
  });
  await capture("move-dialog", async () => {
    await go("/t/thread-ux-auth-error");
    await page
      .getByRole("button", { name: /More actions/ })
      .last()
      .click();
    await page.getByRole("menuitem", { name: /Move to project/ }).click();
  });
  await capture("toast", async () => {
    await go("/t/thread-ux-auth-error");
    await page
      .getByRole("button", { name: /More actions/ })
      .last()
      .click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expectReady(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  });
  if (width === 1440) {
    await capture("sidebar-context", async () => {
      await go("/t/thread-cold-start");
      await page
        .getByRole("navigation", { name: "Threads", exact: true })
        .getByRole("link", { name: /cold-start replay/ })
        .click({ button: "right" });
    });
    await capture("sidebar-rename", async () => {
      await page.getByRole("menuitem", { name: /Rename/ }).click();
      await expectReady(page.getByRole("textbox", { name: "Thread title" })).toBeVisible();
    });
    await page.keyboard.press("Escape");
    await capture("sidebar-hover", async () => {
      await page
        .getByRole("navigation", { name: "Threads", exact: true })
        .getByRole("link", { name: /cold-start replay/ })
        .hover();
      await expectReady(
        page.getByLabel("Details for Cap cold-start replay at 200 events", { exact: true }),
      ).toBeVisible();
    });
    await capture("project-filter", async () => {
      await page.getByRole("button", { name: "Project filter: All projects", exact: true }).click();
    });
    await page.keyboard.press("Escape");
  }
}
