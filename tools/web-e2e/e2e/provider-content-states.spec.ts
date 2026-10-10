import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const output = "/tmp/ace-orch/shots/ui-providers-clean/followup";
mkdirSync(output, { recursive: true });

for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
  for (const width of [1440, 390])
    for (const surface of ["providers", "provider", "usage"])
      test(`${surface} loading, error recovery and empty accounts in ${theme} at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const request = surface === "providers" ? "providers.request" : "accounts.list";
        const route =
          surface === "providers"
            ? "/settings/providers"
            : surface === "provider"
              ? "/settings/providers/claude"
              : "/accounts";
        const loading =
          surface === "providers" ? "providers" : surface === "provider" ? "accounts" : "usage";
        await page.addInitScript(
          ({ theme: selectedTheme, request: selectedRequest }) => {
            localStorage.setItem("ace.appearance", JSON.stringify({ theme: selectedTheme }));
            Object.assign(globalThis, {
              aceFakeWorld: "empty",
              aceFakeSetup: new Function(
                "daemon",
                localStorage.getItem("ace.providersReviewState") === "empty"
                  ? "daemon.services.accounts = [];"
                  : `daemon.${localStorage.getItem("ace.providersReviewState") === "error" ? "failRequests" : "holdRequests"}('${selectedRequest}');`,
              ),
            });
          },
          { theme, request },
        );
        await page.goto(route);
        await expect(
          page.getByRole("status", { name: `Loading ${loading}`, exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: `${output}/${surface}-loading-${theme}-${width}.png`,
          animations: "disabled",
        });
        // Reload to create a fresh request: restoring a held request does not answer it retroactively.
        await page.evaluate(() => localStorage.setItem("ace.providersReviewState", "error"));
        await page.reload();
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        await expect(retry).toBeVisible();
        await page.screenshot({
          path: `${output}/${surface}-error-${theme}-${width}.png`,
          animations: "disabled",
        });
        await page.evaluate(() => new Function("ace.daemon.restoreRequests()")());
        await retry.click();
        await expect(
          surface === "providers"
            ? page.getByRole("group", { name: "Claude Code", exact: true })
            : surface === "provider"
              ? page.getByRole("img", { name: "Your CLI login account" })
              : page.getByRole("article", { name: "Codex Personal" }),
        ).toBeVisible();
        if (surface === "providers") return;
        await page.evaluate(() => localStorage.setItem("ace.providersReviewState", "empty"));
        await page.reload();
        await expect(
          page.getByText(
            surface === "provider" ? "No accounts yet. Add an account below." : "No accounts yet",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.getByRole(surface === "provider" ? "button" : "link", {
            name: surface === "provider" ? "+ Add account" : "Add account",
            exact: true,
          }),
        ).toBeVisible();
        await page.screenshot({
          path: `${output}/${surface}-empty-${theme}-${width}.png`,
          animations: "disabled",
        });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
      });
