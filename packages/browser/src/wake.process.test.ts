import { expect, it, vi } from "vitest";
import { z } from "zod";
import { chromeProcesses } from "./chrome-test-process.ts";
import { executablePath, fixture } from "./test-support.ts";

const Opened = z.object({ tabId: z.string() });

it.skipIf(!executablePath || process.platform === "win32")(
  "waking from sleep finds a browser that stopped answering and brings it back with the thread's tabs",
  async () => {
    const f = await fixture({ wakeWatch: false });
    await f.navigate();
    const side = Opened.parse(
      await f.execute({ action: "tabs", operation: "open", url: `${f.url}/side` }),
    ).tabId;
    const before = f.service.state("thread").tabs?.map((tab) => [tab.tabId, tab.url]);
    const { browser: stopped } = await chromeProcesses(f.home);
    if (!stopped) throw new Error("Browser process missing");
    // The browser froze, as it can across a sleep: nothing asks it anything until the wake.
    process.kill(-stopped, "SIGSTOP");
    try {
      f.service.wake();
      await vi.waitFor(
        async () => {
          const { browser } = await chromeProcesses(f.home);
          expect(browser).toBeDefined();
          expect(browser).not.toBe(stopped);
        },
        { timeout: 30_000, interval: 250 },
      );
      await vi.waitFor(
        async () =>
          expect(
            await f.execute({ action: "evaluate", tabId: side, expression: "location.pathname" }),
          ).toBe("/side"),
        { timeout: 30_000, interval: 250 },
      );
      expect(f.service.state("thread").tabs?.map((tab) => [tab.tabId, tab.url])).toEqual(before);
    } finally {
      try {
        process.kill(-stopped, "SIGCONT");
      } catch {
        /* Already replaced and killed. */
      }
    }
  },
  90_000,
);
