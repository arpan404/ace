import { chromium, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const out = "/tmp/ace-orch/shots/ui-polish-components";
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const browser = await chromium.launch();
const errors: string[] = [];
await mkdir(out, { recursive: true });
async function shot(page: Page, name: string, suffix: string) {
  await page.screenshot({ path: `${out}/${name}-${suffix}.png` });
  console.log(`${name}-${suffix}`);
}
try {
  for (const theme of themes)
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(
        (appearance) =>
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
          ),
        theme,
      );
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => errors.push(`${theme}-${width}: ${error.message}`));
      const suffix = `${theme}-${width}`;
      const go = async (path: string) => {
        await page.goto(`http://127.0.0.1:5397${path}`);
        await expect(page.locator("header h1").first()).toBeVisible();
      };
      const capture = async (name: string, action: () => Promise<void>) => {
        try {
          await action();
          await shot(page, name, suffix);
        } catch (error) {
          errors.push(
            `${name}-${suffix}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
          );
          await shot(page, `failed-${name}`, suffix);
        }
      };
      const command = async (name: string) => {
        await page.keyboard.press("Meta+k");
        await page.getByRole("combobox", { name: "Search commands" }).fill(name);
        await page
          .getByRole("option", { name: new RegExp(`^${name}`) })
          .first()
          .click();
      };
      await go("/t/thread-cold-start");
      await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
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
          await expect(panel).toBeVisible();
          await panel.getByRole("button", { name: "New tab", exact: true }).click();
          await page
            .getByRole("list", { name: "Tools", exact: true })
            .getByRole("button", { name: new RegExp(`^${tool}`) })
            .click();
          await expect(panel.getByRole("tab", { selected: true })).toContainText(
            tool === "Preview" ? "web" : tool,
          );
          if (tool === "Preview")
            await expect(panel.getByRole("button", { name: "Retry", exact: true })).toBeVisible({
              timeout: 15000,
            });
        });
      }
      await capture("panel-launcher", async () => {
        const panel = page.getByRole("region", { name: "Thread panel", exact: true });
        await panel.getByRole("button", { name: "New tab", exact: true }).click();
        await expect(page.getByRole("list", { name: "Tools", exact: true })).toBeVisible();
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
        await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
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
          await expect(page.getByRole("textbox", { name: "Thread title" })).toBeVisible();
        });
        await page.keyboard.press("Escape");
        await capture("sidebar-hover", async () => {
          await page
            .getByRole("navigation", { name: "Threads", exact: true })
            .getByRole("link", { name: /cold-start replay/ })
            .hover();
          await expect(
            page.getByRole("button", { name: /Actions for Cap cold-start/ }),
          ).toBeVisible();
        });
        await capture("project-filter", async () => {
          await page
            .getByRole("button", { name: "Project filter: All projects", exact: true })
            .click();
        });
        await page.keyboard.press("Escape");
      }
      await context.close();
    }
} finally {
  await browser.close();
  await writeFile(`${out}/extra-capture-report.json`, JSON.stringify({ errors }, null, 2));
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
