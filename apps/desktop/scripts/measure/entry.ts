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
  // The app shows its window on `ready-to-show`.
  window.once("ready-to-show", () => {
    marks.windowShown ??= performance.now();
    // In front, so a covered window doesn't measure a backgrounded page.
    if (config.scenario === "open") window.setAlwaysOnTop(true, "floating");
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
