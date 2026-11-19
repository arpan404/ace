import { describe, expect, it } from "vitest";
import { daemonAtQuit, shutDownBeforeQuit } from "./shutdown.ts";

describe("shutdown before quit", () => {
  it("withdraws the update report and stops the browser backend together, then stops the daemon", async () => {
    const events: string[] = [];
    const withdraw = Promise.withResolvers<void>();
    const browser = Promise.withResolvers<void>();
    const done = shutDownBeforeQuit({
      beforeDaemon: [
        { name: "withdraw", run: () => (events.push("withdraw"), withdraw.promise) },
        { name: "browser", run: () => (events.push("browser"), browser.promise) },
      ],
      daemon: async () => void events.push("daemon"),
      now: () => 0,
      log: () => {},
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
        beforeDaemon: [
          { name: "browser", run: () => Promise.reject(new Error("browser backend hung")) },
          { name: "withdraw", run: async () => {} },
        ],
        daemon: async () => void (stopped = true),
        now: () => 0,
        log: () => {},
      }),
    ).rejects.toThrow("browser backend hung");
    expect(stopped).toBe(true);
  });

  it("logs how long each step before the daemon took, a failed one included", async () => {
    let clock = 0;
    const logged: [string, Record<string, unknown>][] = [];
    const withdraw = Promise.withResolvers<void>();
    const browser = Promise.withResolvers<void>();
    const done = shutDownBeforeQuit({
      beforeDaemon: [
        { name: "update report withdrawn", run: () => withdraw.promise },
        { name: "browser backend stopped", run: () => browser.promise },
      ],
      daemon: async () => {},
      now: () => clock,
      log: (message, data) => logged.push([message, data]),
    }).catch(() => {});
    clock = 2_000;
    browser.reject(new Error("hung"));
    await new Promise((resolve) => setImmediate(resolve));
    clock = 3_000;
    withdraw.resolve();
    await done;
    expect(logged).toEqual([
      ["Before quit: browser backend stopped", { ms: 2_000 }],
      ["Before quit: update report withdrawn", { ms: 3_000 }],
    ]);
  });
});

it.each([
  ["a plain quit", { completely: false, updateInstalls: false }, "leave"],
  ["Quit ace completely", { completely: true, updateInstalls: false }, "stop"],
  ["a quit that installs a downloaded update", { completely: false, updateInstalls: true }, "stop"],
] as const)("%s: the daemon this app started is told to %s", (_name, facts, action) => {
  expect(daemonAtQuit(facts)).toBe(action);
});
