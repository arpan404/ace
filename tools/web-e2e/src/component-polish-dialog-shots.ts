import type { ComponentCapture } from "./component-polish-capture.ts";
import { expectReady } from "./component-polish-capture.ts";

export async function captureDialogExtras({ page, width, go, capture }: ComponentCapture) {
  const menu = async () => {
    if (width === 390)
      await page.getByRole("button", { name: "Back to threads", exact: true }).click();
    await page.getByRole("button", { name: /, account/ }).click();
  };
  await capture("profile", async () => {
    await go("/t/thread-ux-auth-error");
    await menu();
  });
  await capture("add-project", async () => {
    await go("/new");
    await page.keyboard.press("Meta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Add project");
    await page.getByRole("option", { name: /^Add project/ }).click();
    await expectReady(page.getByRole("dialog", { name: /Add project/ })).toBeVisible();
  });
  await capture("branch-picker", async () => {
    await go("/new?project=relay");
    if (width === 390) await page.getByRole("button", { name: /^Environment/ }).click();
    await page.getByRole("button", { name: /^Start from:/ }).click();
    await expectReady(page.getByRole("combobox", { name: "Start from branch" })).toBeVisible();
  });
  await capture("skills-detail", async () => {
    await go("/skills/engineering~skill~code-review");
    await expectReady(page.getByRole("heading", { level: 1, name: "Code Review" })).toBeVisible();
  });
  if (width === 1440)
    await capture("skills-filters", async () => {
      await page.getByRole("button", { name: "Filter skills", exact: true }).click();
    });
  await capture("automation-detail", async () => {
    await go("/automations/auto-dependency-audit");
  });
  await capture("automation-editor", async () => {
    await go("/automations/auto-dependency-audit/edit");
  });
  await capture("archived", async () => {
    await go("/archived");
  });
  await capture("setup-step1", async () => {
    await go("/setup");
  });
  for (const step of [2, 3, 4])
    await capture(`setup-step${step}`, async () => {
      await page
        .getByRole("button", { name: step === 2 ? "Get started" : "Continue", exact: true })
        .click();
    });
  await capture("commit-dialog", async () => {
    await go("/t/thread-checkout");
    if (width === 390) {
      await page
        .getByRole("button", { name: /More actions/ })
        .last()
        .click();
      await page.getByRole("menuitem", { name: "Details", exact: true }).click();
    } else await page.getByRole("button", { name: "Work card", exact: true }).click();
    await page.getByRole("button", { name: /Commit & push/ }).click();
    await expectReady(page.getByRole("dialog", { name: /^Commit to/ })).toBeVisible();
  });
  await capture("create-pr-dialog", async () => {
    await page.keyboard.press("Escape");
    if (width === 390) {
      await page
        .getByRole("button", { name: /More actions/ })
        .last()
        .click();
      await page.getByRole("menuitem", { name: "Details", exact: true }).click();
    } else await page.getByRole("button", { name: "Work card", exact: true }).click();
    await page.getByRole("button", { name: "Git actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Create PR…", exact: true }).click();
    await page.getByRole("textbox", { name: "Reviewers" }).fill("alice");
    await page.getByRole("textbox", { name: "Reviewers" }).press("Enter");
  });
  await capture("reconnecting", async () => {
    await go("/t/thread-cold-start");
    await page.evaluate(() => {
      const fake = Reflect.get(globalThis, "ace");
      if (fake && typeof fake === "object") {
        const daemon = Reflect.get(fake, "daemon");
        if (
          daemon &&
          typeof daemon === "object" &&
          typeof Reflect.get(daemon, "refuseConnections") === "function"
        ) {
          daemon.refuseConnections(true);
          daemon.disconnectAll();
        }
      }
    });
    await expectReady(page.getByRole("status").filter({ hasText: /^Reconnecting/ })).toBeVisible();
  });
  await capture("offline", async () => {
    await expectReady(page.getByRole("status").filter({ hasText: /^Offline/ })).toBeVisible({
      timeout: 20000,
    });
  });
}
