import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromiumProcessKiller } from "./index.ts";
import { chromium } from "playwright-core";
import { z } from "zod";
import { expect, it } from "vitest";
import { fixture, executablePath } from "./test-support.ts";

it.skipIf(!executablePath || process.platform === "win32")(
  "a stalled Chromium close force-kills the owned process at its cleanup deadline and releases the service",
  async () => {
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    let expire: (() => void) | undefined;
    let pid = 0;
    const messages: string[] = [];
    const f = await fixture({
      cleanup: {
        timeoutMs: 1234,
        schedule(callback) {
          expire = callback;
          return () => {
            expire = undefined;
          };
        },
        onTimeout: (message) => messages.push(message),
      },
      launchContext: async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, options);
        const browser = context.browser();
        if (!browser) throw new Error("Browser missing");
        browser.once("disconnected", () => disconnected.resolve());
        const cdp = await browser.newBrowserCDPSession();
        const info = z
          .object({ processInfo: z.array(z.object({ type: z.string(), id: z.number() })) })
          .parse(await cdp.send("SystemInfo.getProcessInfo"));
        pid = info.processInfo.find((entry) => entry.type === "browser")?.id ?? 0;
        await cdp.detach();
        const close = context.close.bind(context);
        context.close = () => {
          entered.resolve();
          return close();
        };
        return context;
      },
    });
    // Stop the real Chromium group, so it cannot answer Playwright's graceful close.

    expect(pid).toBeGreaterThan(0);
    process.kill(-pid, "SIGSTOP");
    const closing = f.service.close();
    try {
      await entered.promise;
      expect(expire).toBeTypeOf("function");
      expire?.();
      await expect(closing).resolves.toBeUndefined();
      await disconnected.promise;
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(messages).toEqual(["Chromium cleanup exceeded 1234ms; force-killed browser"]);
      await expect(f.service.open({ threadId: "later", workspaceId: "workspace" })).rejects.toThrow(
        "shutting down",
      );
    } finally {
      try {
        process.kill(-pid, "SIGCONT");
      } catch {
        /* Already force-killed. */
      }
      await closing;
    }
  },
);

it("Windows tree termination is asynchronous and an already-exited process is successful cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  await once(child, "spawn");
  const pid = child.pid;
  if (pid === undefined || pid < 1) throw new Error("Missing owned process");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exited = once(child, "exit");
  const killer = chromiumProcessKiller("win32", async () => {
    entered.resolve();
    await release.promise;
    child.kill("SIGKILL");
    await exited;
    throw new Error("taskkill: process already exited");
  });
  let finished = false;
  try {
    const killing = killer(pid).then(() => {
      finished = true;
    });
    await entered.promise;
    expect(finished).toBe(false);
    release.resolve();
    await expect(killing).resolves.toBeUndefined();
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    release.resolve();
    child.kill("SIGKILL");
  }
});

it.each([0, -1, Number.NaN, 1.5])(
  "rejects unsafe Chromium identity %s before signaling any process",
  async (pid) => {
    const killer = chromiumProcessKiller("win32", async () => {
      throw new Error("An invalid process was signaled");
    });
    await expect(killer(pid)).rejects.toThrow("Invalid Chromium process identity");
  },
);
