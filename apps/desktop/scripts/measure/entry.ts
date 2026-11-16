/**
 * Main-process entry for `measure:memory` only, never shipped: the real app (`src/main`),
 * startup marks (ms since the main process started), and the scenario the driver asked for
 * in ACE_MEASURE, run inside the main process so no inspector or remote-debugging client
 * skews what is measured.
 */
// The app itself, run for its side effects exactly as `src/main/index.ts` ships.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/main/index.ts";
import { app } from "electron";
import { measureOpen } from "./open.ts";
import { runScenario, ScenarioConfig } from "./scenario.ts";

const marks: Record<string, number> = { evaluated: performance.now() };
const config = ScenarioConfig.parse(JSON.parse(process.env.ACE_MEASURE ?? "null"));
void app.whenReady().then(() => {
  marks.ready ??= performance.now();
});
app.once("browser-window-created", (_event, window) => {
  marks.windowCreated ??= performance.now();
  // ACE_MEASURE_DEBUG: the page's console, timed like the marks, for tracing a start.
  if (process.env.ACE_MEASURE_DEBUG)
    window.webContents.on("console-message", (event) =>
      console.error(`console ${performance.now().toFixed(0)} ${event.level} ${event.message}`),
    );
  // The app shows its window on `ready-to-show`.
  window.once("ready-to-show", () => {
    marks.windowShown ??= performance.now();
    // In front, so a covered window doesn't measure a backgrounded page.
    if (config.scenario === "open") window.setAlwaysOnTop(true, "floating");
    // ACE_MEASURE_HIDE_MS: the person looks away as it opens (the window hidden once the app
    // shows it) and back after that long; `shownAgain` marks when.
    const hideMs = Number(process.env.ACE_MEASURE_HIDE_MS ?? 0);
    if (config.scenario === "open" && hideMs > 0) {
      setTimeout(() => window.hide(), 0);
      setTimeout(() => {
        marks.shownAgain = performance.now();
        window.show();
      }, hideMs);
    }
  });
  window.webContents.once("did-finish-load", () => {
    marks.rendererLoaded ??= performance.now();
    if (config.scenario !== "open") void runScenario(window, config, marks);
  });
  if (config.scenario === "open")
    // From the window's creation up to the first usable screen.
    void measureOpen(window, marks).finally(() => {
      process.stdout.write(`ACE_MEASURE ${JSON.stringify({ marks })}\n`);
      process.stdout.write(`ACE_MEASURE ${JSON.stringify({ done: true })}\n`);
      app.quit();
    });
});
