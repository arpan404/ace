import { BrowserOpen } from "@ace/protocol";
import { app, type BrowserWindow } from "electron";
import { z } from "zod";
import type { ViewPage } from "../../src/main/browser/backend.ts";
import { EmbeddedViews } from "../../src/main/browser/views.ts";
import { sample, startPhase } from "./sample.ts";

/** What the driver (`scripts/measure-memory.ts`) asks this run to do, from the env. */
export const ScenarioConfig = z.object({
  scenario: z.enum(["startup", "lifecycle", "browser", "streaming"]),
  hiddenMs: z.number(),
  streamMs: z.number(),
  settleMs: z.number(),
  churn: z.number().int(),
  /** The busy test page the embedded browser loads (served by the driver). */
  pageUrl: z.string(),
});
export type ScenarioConfig = z.infer<typeof ScenarioConfig>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One JSON line on stdout for the driver. */
const report = (message: unknown) =>
  process.stdout.write(`ACE_MEASURE ${JSON.stringify(message)}\n`);

async function shellVisible(window: BrowserWindow): Promise<void> {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const found = await window.webContents
      .executeJavaScript(`Boolean(document.querySelector('nav[aria-label="Views"]'))`)
      .catch(() => false);
    if (found === true) return;
    await wait(25);
  }
  throw new Error("The app shell never rendered");
}

/**
 * Shows the window in front of everything: macOS treats a window that other windows cover as
 * hidden, so on a busy desktop "visible" phases would otherwise measure a backgrounded page.
 */
function front(window: BrowserWindow): void {
  window.setAlwaysOnTop(true, "floating");
  window.show();
  window.focus();
}

async function phase(window: BrowserWindow, name: string, ms: number): Promise<void> {
  startPhase();
  await wait(ms);
  report({ sample: await sample(name, window.webContents) });
}

async function lifecycle(window: BrowserWindow, config: ScenarioConfig): Promise<void> {
  const hidden = `${config.hiddenMs / 1_000}s`;
  await phase(window, "idle", config.settleMs);
  window.hide();
  await phase(window, `hidden ${hidden}`, config.hiddenMs);
  front(window);
  await phase(window, "shown again", 5_000);
  window.minimize();
  await phase(window, `minimised ${hidden}`, config.hiddenMs);
  window.restore();
  front(window);
  await phase(window, "restored", 5_000);
  await browser(window, config);
}

async function browser(window: BrowserWindow, config: ScenarioConfig): Promise<void> {
  const hidden = `${config.hiddenMs / 1_000}s`;
  // The embedded browser, through the real view host, as the daemon's `open`/`close` do.
  const views = new EmbeddedViews({
    window: () => window,
    platform: process.platform,
    log: (message) => console.error(message),
  });
  const open = async (id: string): Promise<ViewPage> => {
    const page = await views.open({
      sessionId: id,
      options: BrowserOpen.parse({ threadId: id, workspaceId: "workspace-measure" }),
      viewport: { width: 900, height: 600 },
    });
    await page.navigate(config.pageUrl, 30_000);
    return page;
  };
  const place = (id: string, visible: boolean) =>
    views.place(
      { threadId: id, bounds: { x: 320, y: 60, width: 900, height: 600 }, visible },
      { id: window.webContents.id, window, zoom: 1 },
    );
  const page = await open("measure-view");
  place("measure-view", true);
  await phase(window, "browser open, visible", 15_000);
  place("measure-view", false);
  await phase(window, `browser open, hidden ${hidden}`, config.hiddenMs);
  // The agent last drove the view before it was hidden, so by now it is throttled.
  await phase(window, `browser open, hidden ${hidden} more`, config.hiddenMs);
  await page.close();
  await phase(window, "browser closed", config.settleMs);
  for (let index = 0; index < config.churn; index++)
    await (await open(`measure-churn-${index}`)).close();
  await phase(window, `after ${config.churn} more browser sessions`, config.settleMs);
}

async function streaming(window: BrowserWindow, config: ScenarioConfig): Promise<void> {
  const contents = window.webContents;
  await contents.loadURL("app://ace/t/thread-soak?rate=5000");
  await shellVisible(window);
  const events = async () =>
    Number(await contents.executeJavaScript("globalThis.acePerf?.events ?? 0").catch(() => 0));
  const before = await events();
  const startedAt = performance.now();
  await phase(window, `streaming ${config.streamMs / 1_000}s`, config.streamMs);
  report({
    streamingRate: ((await events()) - before) / ((performance.now() - startedAt) / 1_000),
  });
  window.hide();
  await phase(window, `streaming, hidden ${config.hiddenMs / 1_000}s`, config.hiddenMs);
  front(window);
  await phase(window, "streaming, shown again", 5_000);
}

/** Runs one scenario against the app's first window, reports on stdout, then quits. */
export async function runScenario(
  window: BrowserWindow,
  config: ScenarioConfig,
  marks: Record<string, number>,
): Promise<void> {
  try {
    front(window);
    await shellVisible(window);
    marks.shellVisible = performance.now();
    if (config.scenario === "startup") report({ marks });
    else if (config.scenario === "lifecycle") await lifecycle(window, config);
    else if (config.scenario === "browser") await browser(window, config);
    else await streaming(window, config);
    report({ done: true });
  } catch (error) {
    report({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  } finally {
    app.quit();
  }
}
