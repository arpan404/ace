import { describe, expect, it } from "vitest";
import { watchDesktopTarget, type DesktopDaemonStatus } from "./desktop.ts";
import { reconnectWhenDesktopDaemonRuns } from "./desktop-reconnect.ts";

const kept = "ab".repeat(32);
const real = "cd".repeat(32);

/** A desktop bridge whose daemon starts when the test says, handing over `handed()` each time. */
function desktop(handed: () => unknown) {
  const listeners = new Set<(status: DesktopDaemonStatus) => void>();
  let status: DesktopDaemonStatus = { state: "starting" };
  const scope = {
    ace: {
      platform: "darwin",
      daemon: {
        connection: async () => handed(),
        status: async () => status,
        onStatus(listener: (status: DesktopDaemonStatus) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  };
  return {
    scope,
    emit(next: DesktopDaemonStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a page opened before its desktop daemon answers", () => {
  it("retries its waiting reconnect at once when the daemon runs, not after its backoff", () => {
    const d = desktop(() => undefined);
    let retries = 0;
    const stop = reconnectWhenDesktopDaemonRuns({ reconnectNow: () => retries++ }, d.scope);
    d.emit({ state: "starting" });
    d.emit({ state: "restarting" });
    expect(retries).toBe(0);
    d.emit({ state: "running" });
    expect(retries).toBe(1);
    stop();
    d.emit({ state: "running" });
    expect(retries).toBe(1);
  });

  it("is handed the real target once the daemon runs, when it differs from what the home kept", async () => {
    let running = false;
    const d = desktop(() => ({
      mode: "daemon",
      url: running ? "ws://127.0.0.1:5151/" : "ws://127.0.0.1:4242/",
      token: running ? real : kept,
      localHostId: "host-1",
    }));
    const targets: unknown[] = [];
    const stop = watchDesktopTarget((target) => targets.push(target), d.scope);
    await settle();
    // Still starting: nothing to adopt beyond what the page opened with.
    expect(targets).toEqual([]);
    running = true;
    d.emit({ state: "running" });
    await settle();
    expect(targets).toEqual([{ url: "ws://127.0.0.1:5151/", token: real, localHostId: "host-1" }]);
    stop();
  });

  it("does nothing in a browser", () => {
    let retries = 0;
    const stop = reconnectWhenDesktopDaemonRuns({ reconnectNow: () => retries++ }, {});
    stop();
    expect(retries).toBe(0);
  });
});
