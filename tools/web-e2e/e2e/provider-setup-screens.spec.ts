import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const output = "/tmp/ace-orch/shots/fix-one-click-install-signin";
mkdirSync(output, { recursive: true });

/** This code runs only in the fake browser, against its explicitly exposed fixture controls. */
const stage = (page: Page, body: string) => page.evaluate((code) => new Function(code)(), body);

async function prepare(page: Page, theme: string, width: number, scenario = "failure") {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(
    ({ theme: selectedTheme, scenario: selectedScenario }) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme }));
      Object.assign(globalThis, {
        aceFakeWorld: "empty",
        aceFakeSetup: new Function(
          "daemon",
          `
        daemon.services.providerInstalls.autoComplete = false;
        daemon.services.providerInstalls.scenarios.antigravity = ${JSON.stringify(selectedScenario)};
        daemon.services.installed.delete('antigravity');
        const row = daemon.services.providerStatuses.find(row => row.provider === 'antigravity');
        Object.assign(row, {installed:false, auth:'logged_out'});
        daemon.services.models = daemon.services.models.filter(model => model.provider !== 'antigravity');
      `,
        ),
      });
    },
    { theme, scenario },
  );
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
}

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    for (const surface of ["setup", "settings", "provider"])
      test(`${surface}: install, retry, sign in and ready at ${width} in ${theme}`, async ({
        page,
      }) => {
        await prepare(page, theme, width);
        await page.goto(
          surface === "setup"
            ? "/setup"
            : surface === "provider"
              ? "/settings/providers/antigravity"
              : "/settings/providers",
        );
        if (surface === "setup") {
          await expect(page.getByRole("button", { name: "Get started" })).toBeVisible();
          await capture(page, `setup-${theme}-${width}-welcome`);
          await page.getByRole("button", { name: "Get started" }).click();
        }
        const row = () =>
          page.getByRole(
            surface === "setup" ? "listitem" : surface === "provider" ? "region" : "group",
            { name: surface === "provider" ? "Setup" : "Antigravity" },
          );
        const prefix = `${surface}-${theme}-${width}`;
        await expect(row().getByRole("button", { name: "Install", exact: true })).toBeVisible();
        await capture(page, `${prefix}-install`);
        await row().getByRole("button", { name: "Install", exact: true }).click();
        await expect(row().getByRole("progressbar")).toBeVisible();
        await capture(page, `${prefix}-installing`);
        await row().getByRole("button", { name: "Cancel Antigravity installation" }).click();
        await expect(row().getByRole("button", { name: "Install", exact: true })).toBeVisible();
        await capture(page, `${prefix}-cancelled`);
        await row().getByRole("button", { name: "Install", exact: true }).click();
        await expect(row().getByRole("progressbar")).toBeVisible();
        await stage(page, "ace.daemon.services.providerInstalls.complete('fake-install-2')");
        await expect(row().getByRole("button", { name: "Retry", exact: true })).toBeVisible();
        await row().getByRole("button", { name: "Antigravity installation details" }).click();
        await capture(page, `${prefix}-failed-details`);
        await stage(page, "ace.daemon.services.providerInstalls.scenarios.antigravity = 'success'");
        await row().getByRole("button", { name: "Retry", exact: true }).click();
        await expect(row().getByRole("progressbar")).toBeVisible();
        await stage(page, "ace.daemon.services.providerInstalls.complete('fake-install-3')");
        await expect(row().getByRole("button", { name: "Sign in to Antigravity" })).toBeVisible();
        await capture(page, `${prefix}-sign-in`);
        await row().getByRole("button", { name: "Sign in to Antigravity" }).click();
        const dialog = page.getByRole("dialog", { name: "Sign in to Antigravity" });
        await expect(dialog.getByRole("link", { name: "Open sign-in page" })).toBeVisible();
        await capture(page, `${prefix}-signing-in`);
        await stage(page, "ace.daemon.services.providerLogin.complete('fake-login-1')");
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        await expect(row().getByText("Ready", { exact: true })).toBeVisible();
        await capture(page, `${prefix}-ready`);
      });

for (const theme of ["midnight", "graphite", "paper", "slate", "contrast"])
  test(`provider Install uses the ${theme} theme at phone width`, async ({ page }) => {
    await prepare(page, theme, 390);
    await page.goto("/settings/providers/antigravity");
    await expect(
      page.getByRole("region", { name: "Setup" }).getByRole("button", { name: "Install" }),
    ).toBeVisible();
    await capture(page, `provider-${theme}-390-install`);
  });

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    for (const scenario of ["missing_prerequisite", "download_only"])
      test(`provider ${scenario} at ${width} in ${theme}`, async ({ page }) => {
        await prepare(page, theme, width, scenario);
        await page.goto("/settings/providers/antigravity");
        const row = page.getByRole("region", { name: "Setup" });
        await row.getByRole("button", { name: "Install", exact: true }).click();
        await expect(
          row.getByRole("link", {
            name: scenario === "missing_prerequisite" ? "Get Node.js" : "Get Antigravity",
            exact: true,
          }),
        ).toBeVisible();
        await capture(page, `provider-${theme}-${width}-${scenario}`);
      });

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`settings update at ${width} in ${theme}`, async ({ page }) => {
      await prepare(page, theme, width);
      await page.goto("/settings/providers");
      const row = page.getByRole("group", { name: "Codex" });
      await expect(row.getByRole("button", { name: "Update", exact: true })).toBeVisible();
      await capture(page, `settings-${theme}-${width}-update`);
      await row.getByRole("button", { name: "Update", exact: true }).click();
      await expect(row.getByRole("progressbar")).toBeVisible();
      await capture(page, `settings-${theme}-${width}-updating`);
      await stage(page, "ace.daemon.services.providerInstalls.complete('fake-install-1')");
      await expect(row.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
      await expect(row.getByText("Ready", { exact: true })).toBeVisible();
    });
