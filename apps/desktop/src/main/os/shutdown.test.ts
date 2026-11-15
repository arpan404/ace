import { describe, expect, it } from "vitest";
import { shutDownBeforeQuit } from "./shutdown.ts";

describe("shutdown before quit", () => {
  it("withdraws the update report and stops the browser backend together, then stops the daemon", async () => {
    const events: string[] = [];
    const withdraw = Promise.withResolvers<void>();
    const browser = Promise.withResolvers<void>();
    const done = shutDownBeforeQuit({
      beforeDaemon: [
        () => (events.push("withdraw"), withdraw.promise),
        () => (events.push("browser"), browser.promise),
      ],
      daemon: async () => void events.push("daemon"),
    });
    await Promise.resolve();
    expect(events).toEqual(["withdraw", "browser"]);
    withdraw.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    // The browser backend is still telling the daemon: the daemon keeps running.
    expect(events).not.toContain("daemon");
    browser.resolve();
    await done;
    expect(events).toEqual(["withdraw", "browser", "daemon"]);
  });

  it("stops the daemon even when an earlier step fails, and reports that failure", async () => {
    let stopped = false;
    await expect(
      shutDownBeforeQuit({
        beforeDaemon: [() => Promise.reject(new Error("browser backend hung")), async () => {}],
        daemon: async () => void (stopped = true),
      }),
    ).rejects.toThrow("browser backend hung");
    expect(stopped).toBe(true);
  });
});
