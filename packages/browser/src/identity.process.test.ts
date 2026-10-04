import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserOpen } from "@ace/protocol";
import { expect, test } from "vitest";
import { HeadlessBackend, type BackendOpen } from "./index.ts";
import { executablePath } from "./test-support.ts";

test.skipIf(!executablePath).each(["error", "missing", "cancel", "deadline"])(
  "Chromium identity %s releases the launched context and profile lock",
  async (failure) => {
    if (!executablePath) throw new Error("Chromium unavailable");
    const profile = await mkdtemp(join(tmpdir(), "ace-browser-identity-"));
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const controller = new AbortController();
    const timers = new Map<number, () => void>();
    const backend = new HeadlessBackend(
      async () => {
        if (!executablePath) throw new Error("Chromium unavailable");
        return executablePath;
      },
      async (path, options) => {
        const context = await chromium.launchPersistentContext(path, options);
        context.once("close", () => closed.resolve());
        const browser = context.browser();
        if (!browser) throw new Error("Chromium unavailable");
        const session = browser.newBrowserCDPSession.bind(browser);
        browser.newBrowserCDPSession = async () => {
          const cdp = await session();
          Object.defineProperty(cdp, "send", {
            value: async () => {
              entered.resolve();
              if (failure === "error") throw new Error("identity failed");
              if (failure === "missing") return { processInfo: [] };
              return new Promise<never>(() => {});
            },
          });
          return cdp;
        };
        return context;
      },
      {
        schedule(callback, delay) {
          timers.set(delay, callback);
          return () => {
            timers.delete(delay);
          };
        },
      },
    );
    const request: BackendOpen = {
      options: BrowserOpen.parse({ threadId: "thread", workspaceId: "workspace" }),
      profileDir: profile,
      signal: controller.signal,
      allowed: async () => false,
      navigation() {},
      log() {},
      lost() {},
    };
    try {
      const opening = backend.open(request);
      const rejected = expect(opening).rejects.toThrow(/identity/);
      await entered.promise;
      if (failure === "cancel") controller.abort();
      if (failure === "deadline") timers.get(2000)?.();
      await rejected;
      await closed.promise;
      // Relaunching the same persistent profile proves that ownership was released.
      const reopened = await chromium.launchPersistentContext(profile, {
        executablePath,
        headless: true,
      });
      await reopened.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
);
