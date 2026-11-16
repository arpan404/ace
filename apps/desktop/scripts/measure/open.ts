import type { BrowserWindow } from "electron";

/**
 * When opening the app reaches what a person can see and use, in ms since the main process
 * started (`performance.timeOrigin` of both processes is wall-clock time):
 * - `shell`: the shell is on screen, nothing covering it (startup cover gone or fading);
 * - `rows`: real thread rows (not skeletons) in the sidebar, uncovered;
 * - `composer`: an enabled message input, uncovered;
 * - `live`: connected to the daemon, so what shows is live, not only what the window kept.
 * `hidden` is 1 when the page was hidden at any point before them: a hidden page is sent no thread
 * data (ADR 0056), so such a run measures when it was shown again, not the start.
 * Polled from the main process, so the page under measurement carries no probe code.
 */
export type OpenMilestone = "shell" | "rows" | "composer" | "live";

const probe = `(() => {
  globalThis.__aceMeasureDebug = ${Boolean(process.env.ACE_MEASURE_DEBUG)};
  const covered = Boolean(document.querySelector('[data-slot="startup-screen"]:not([data-leaving])') || document.querySelector('#boot'));
  const shell = Boolean(document.querySelector('[data-part="app"] [data-part="rail"]'));
  const rows = document.querySelectorAll('[data-part="thread-row"]').length;
  const input = document.querySelector('[data-part="composer-input"] [contenteditable="true"], [data-part="composer-input"] textarea:not([disabled])');
  const cached = document.querySelector('[data-part="app"]')?.getAttribute('data-connection') !== 'ready';
  const hidden = document.visibilityState !== 'visible';
  return { at: performance.timeOrigin + performance.now(), covered, shell, rows, composer: Boolean(input), cached, hidden, ...(globalThis.__aceMeasureDebug ? { href: location.href, conn: document.querySelector('[data-part="app"]')?.getAttribute('data-connection'), vis: document.visibilityState } : {}) };
})()`;

interface ProbeResult {
  at: number;
  covered: boolean;
  shell: boolean;
  rows: number;
  composer: boolean;
  cached: boolean;
  hidden: boolean;
}

export async function measureOpen(
  window: BrowserWindow,
  marks: Record<string, number>,
  timeoutMs = 30_000,
): Promise<void> {
  const origin = performance.timeOrigin;
  const deadline = performance.now() + timeoutMs;
  const since = (at: number) => at - origin;
  let last = "";
  while (performance.now() < deadline) {
    const state = (await window.webContents.executeJavaScript(probe).catch(() => undefined)) as
      | ProbeResult
      | undefined;
    if (process.env.ACE_MEASURE_DEBUG) {
      const seen = JSON.stringify({
        ...state,
        at: undefined,
        win: {
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          focused: window.isFocused(),
        },
      });
      if (seen !== last) console.error("probe", state ? since(state.at).toFixed(0) : "-", seen);
      last = seen;
    }
    // Before the window is first shown its page is hidden anyway.
    if (state?.hidden && marks.windowShown !== undefined) {
      // ACE_MEASURE_SCREEN=<path>: what the display really showed when the page read hidden.
      const screen = process.env.ACE_MEASURE_SCREEN;
      if (screen && marks.hidden === undefined) {
        const { execFile } = await import("node:child_process");
        execFile("screencapture", ["-x", screen], () => {});
      }
      marks.hidden = 1;
    }
    if (state && !state.covered) {
      // ACE_MEASURE_SHOT=<prefix>: what the window shows the moment it's uncovered, and later.
      const shot = process.env.ACE_MEASURE_SHOT;
      if (shot && marks.shell === undefined) {
        void capture(window, `${shot}-uncovered.png`);
        setTimeout(() => void capture(window, `${shot}-later.png`), 1_500);
      }
      if (state.shell) marks.shell ??= since(state.at);
      if (state.rows > 0) {
        marks.rows ??= since(state.at);
        marks.rowCount = state.rows;
      }
      if (state.composer) marks.composer ??= since(state.at);
      if (state.rows > 0 && !state.cached) marks.live ??= since(state.at);
    }
    if (
      marks.shell !== undefined &&
      marks.rows !== undefined &&
      marks.composer !== undefined &&
      marks.live !== undefined
    ) {
      if (process.env.ACE_MEASURE_SHOT) await new Promise((resolve) => setTimeout(resolve, 2_000));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

async function capture(window: BrowserWindow, path: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, (await window.webContents.capturePage()).toPNG());
}
