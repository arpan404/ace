import { powerMonitor, type BrowserWindow } from "electron";

const connection = `document.querySelector('[data-part="app"]')?.getAttribute('data-connection') ?? null`;

/**
 * Waking from sleep, in ms: the driver freezes the daemon while the app is live (its page's
 * socket goes quiet and its retries back off, as around a sleep), lets it run again, then sends
 * SIGUSR2. That fires Electron's own
 * powerMonitor `resume`, as the OS does on waking, and `wakeToLive` is how long the page then
 * takes to be connected again. `offAtWake` is 1 when the page was indeed not connected then.
 */
export async function measureWake(
  window: BrowserWindow,
  marks: Record<string, number>,
  timeoutMs = 60_000,
): Promise<void> {
  process.stdout.write(`ACE_MEASURE ${JSON.stringify({ live: true })}\n`);
  await new Promise((resolve) => process.once("SIGUSR2", resolve));
  const read = async () =>
    (await window.webContents.executeJavaScript(connection).catch(() => null)) as string | null;
  marks.offAtWake = (await read()) === "ready" ? 0 : 1;
  const at = performance.now();
  powerMonitor.emit("resume");
  const deadline = at + timeoutMs;
  while (performance.now() < deadline) {
    if ((await read()) === "ready") {
      marks.wakeToLive = performance.now() - at;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}
