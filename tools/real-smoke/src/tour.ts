import { expect as playwrightExpect, type Page } from "@playwright/test";
import { checkPage, type Finding, type PageFacts } from "./checks.ts";
import { pageFacts, privateScreenshot, usageScreenshot } from "./dom.ts";
import { writeReport, type Report } from "./report.ts";
import { sidebarThreads } from "./sidebar.ts";
import { join } from "node:path";
import { observeSurfaces } from "./surfaces.ts";

export interface Tour {
  signal: AbortSignal;
  page: Page;
  origin: string;
  out: string;
  report: Report;
  maxThreads: number;
  stepTimeoutMs: number;
  scanTimeoutMs: number;
  scrub(text: string): string;
  catalogs(): Promise<void>;
  scan(): Promise<void>;
  pastSessionsPath(): Promise<string>;
  coldPage(): Promise<Page>;
}
/** Keep visiting independent pages after a failed step; every attempt gets evidence. */
export async function runTour(options: Tour) {
  const expect = playwrightExpect.configure({ timeout: options.stepTimeoutMs });
  let page = options.page;
  let ready = false;
  let stepName = "startup",
    screenshot = "";
  const add = (finding: Finding) =>
    options.report.failures.push({ ...finding, step: stepName, screenshot });
  const watch = async (target: Page) => {
    await target.addInitScript(observeSurfaces);
    target.on("console", (message) => {
      if (message.type() === "error")
        add({ code: "console-error", message: options.scrub(message.text()).slice(0, 500) });
    });
    target.on("pageerror", (error) =>
      add({ code: "unhandled-rejection", message: options.scrub(error.message).slice(0, 500) }),
    );
    target.on("crash", () => add({ code: "page-crash", message: "Chromium page crashed" }));
    target.setDefaultTimeout(options.stepTimeoutMs);
  };
  await watch(page);
  const visit = async (path: string) => {
    await page.goto(`${options.origin}${path}`);
    await expect(page.locator("main").first()).toBeVisible();
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0, {
      timeout: options.stepTimeoutMs,
    });
    await expect(page.locator('[role="status"][aria-label^="Loading "]:visible')).toHaveCount(0, {
      timeout: options.stepTimeoutMs,
    });
  };
  const step = async (
    name: string,
    action: () => Promise<unknown>,
    expected: PageFacts["expected"] = {},
  ) => {
    options.signal.throwIfAborted();
    stepName = name;
    screenshot = `screenshots/${String(options.report.steps.length + 1).padStart(3, "0")}-${name}.png`;
    options.report.activeStep = { name, screenshot };
    const began = performance.now();
    try {
      await action();
    } catch (error) {
      add({
        code: "step-failed",
        message: options
          .scrub(error instanceof Error ? error.message : String(error))
          .slice(0, 500),
      });
    }
    try {
      // Brand chunks are lazy; a path is the readiness signal, never a fixed sleep.
      await expect
        .poll(
          async () =>
            (await page.evaluate(pageFacts, { catalogsReady: ready, expected })).icons.every(
              (icon) => icon.brand,
            ),
          { timeout: options.stepTimeoutMs },
        )
        .toBe(true);
    } catch {
      /* collector records missing brand marks */
    }
    try {
      const facts = await page.evaluate(pageFacts, { catalogsReady: ready, expected });
      for (const finding of checkPage(facts)) add(finding);
      await (stepName === "usage-accounts" ? usageScreenshot : privateScreenshot)(
        page,
        join(options.out, screenshot),
        options.scrub,
      );
      await page.evaluate(() => {
        window.aceSmokeAlerts = [];
      });
    } catch (error) {
      add({ code: "evidence-failed", message: options.scrub(String(error)).slice(0, 500) });
    }
    const durationMs = performance.now() - began;
    options.report.steps.push({ name, durationMs, screenshot });
    if (
      name.startsWith("thread-") ||
      ["cold-start", "catalogs-ready", "past-sessions-scan"].includes(name)
    )
      options.report.timings[name] = durationMs;
    await writeReport(options.out, options.report, options.scrub);
    process.stdout.write(`smoke ${name}: ${Math.round(durationMs)}ms\n`);
  };
  const coldBegan = performance.now();
  await step("cold-start", () => visit("/new"));
  await step(
    "catalogs-ready",
    async () => {
      await options.catalogs();
      ready = true;
      options.report.timings.catalogsReadySinceNavigation = performance.now() - coldBegan;
      await expect(page.getByRole("button", { name: /^Model:/ }).first()).not.toHaveAccessibleName(
        /loading/i,
      );
    },
    { models: true },
  );
  const threads: string[] = [];
  await step("sidebar", async () => {
    threads.push(...(await sidebarThreads(page, options.maxThreads)));
    if (!threads.length) throw new Error("Sidebar has no real threads to inspect");
  });
  for (const [index, path] of threads.entries()) {
    await step(`thread-${index + 1}`, async () => {
      await visit(path);
      await expect(page.getByRole("feed", { name: "Transcript", exact: true })).toBeVisible();
      options.report.threadsVisited++;
    });
  }
  await step("new-thread-past-sessions", async () => visit(await options.pastSessionsPath()));
  await step(
    "past-sessions-scan",
    async () => {
      await options.scan();
      await visit(await options.pastSessionsPath());
      await expect(
        page.getByRole("button", { name: "Show all past sessions", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Show all past sessions", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Past sessions", exact: true })).toBeVisible();
      await expect(page.getByText("Looking for saved conversations…", { exact: true })).toHaveCount(
        0,
        { timeout: options.scanTimeoutMs },
      );
    },
    { sessions: true },
  );
  await step("import", async () => {
    const dialog = page.getByRole("dialog", { name: "Past sessions", exact: true });
    const button = dialog.getByRole("button", { name: /^Import / }).first();
    await button.hover();
    await button.click();
    await expect(page).toHaveURL(/\/t\//);
    await expect(page.getByRole("feed", { name: "Transcript", exact: true })).toBeVisible();
  });
  await step("model-picker", async () => {
    await visit("/new");
    await page
      .getByRole("button", { name: /^Model:/ })
      .first()
      .click();
    await page.getByRole("button", { name: /^Change model:/ }).click();
    await expect(page.getByRole("tablist", { name: "Model sources" })).toBeVisible();
  });
  const tabs = await page.getByRole("tablist", { name: "Model sources" }).getByRole("tab").all();
  for (const [index, tab] of tabs.entries())
    await step(`model-provider-${index + 1}`, async () => {
      if (await tab.isEnabled()) {
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
      }
    });
  await step("providers", () => visit("/settings/providers"));
  const providers = await page
    .locator('a[href^="/settings/providers/"]')
    .evaluateAll((elements) => [
      ...new Set(elements.map((element) => element.getAttribute("href") ?? "")),
    ]);
  for (const path of providers) await step(`provider-${path.split("/").at(-1)}`, () => visit(path));
  await step("usage-accounts", () => visit("/accounts"));
  await step(
    "skills-cold-start",
    async () => {
      await page.close();
      page = await options.coldPage();
      await watch(page);
      await visit("/skills");
      await expect(page.locator('a[href^="/skills/"]').first()).toBeVisible();
    },
    { skills: true },
  );
  await step(
    "slash-cold-start",
    async () => {
      await page.close();
      page = await options.coldPage();
      await watch(page);
      await visit("/new");
      const message = page.getByRole("combobox", { name: "Message" });
      await message.fill("/");
      await expect(page.getByRole("listbox").first()).toBeVisible();
      await expect(page.getByRole("option").first()).toBeVisible();
    },
    { skills: true },
  );
  await step("activity", () => visit("/activity"));
  for (const tab of ["All", "Needs you", "Mentions", "Runs"])
    await step(`activity-${tab.toLowerCase().replaceAll(" ", "-")}`, async () => {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      await expect(page.getByRole("tab", { name: new RegExp(`^${tab}`) })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  for (const path of [
    "general",
    "appearance",
    "prompts",
    "notifications",
    "remote",
    "computer-use",
    "keyboard",
    "advanced",
    "theme-editor",
  ])
    await step(`settings-${path}`, () => visit(`/settings/${path}`));
  await step("deleted-thread", async () => {
    await visit("/t/real-smoke-deleted-thread");
    await expect(
      page
        .getByText(/thread.*(?:deleted|not found|unavailable|doesn't exist)|couldn't.*thread/i)
        .first(),
    ).toBeVisible();
  });
  options.report.completed = true;
  delete options.report.activeStep;
  await page.context().close();
}
