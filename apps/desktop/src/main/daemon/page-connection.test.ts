import { describe, expect, it } from "vitest";
import type { DaemonConnection, DaemonStatus } from "../../shared/contract.ts";
import { createPageConnection } from "./page-connection.ts";

const kept: DaemonConnection = {
  mode: "daemon",
  url: "ws://127.0.0.1:4242/",
  token: "ab".repeat(32),
  localHostId: "host-1",
};
const real: DaemonConnection = { ...kept, url: "ws://127.0.0.1:5151/" };

/** An app whose daemon starts when the test says; the home's files are read when it says too. */
function app() {
  let status: DaemonStatus = { state: "starting", source: "app", restarts: 0, paused: false };
  const listeners = new Set<(status: DaemonStatus) => void>();
  const read = Promise.withResolvers<DaemonConnection | undefined>();
  let reloads = 0;
  const failure = () =>
    status.state === "failed" ? Promise.reject(new Error("The daemon could not start")) : undefined;
  const handoff = createPageConnection({
    early: () => read.promise,
    connection: () => failure() ?? Promise.resolve(real),
    current: () => status,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: () => reloads++,
  });
  return {
    handoff,
    reloads: () => reloads,
    filesRead: (connection: DaemonConnection | undefined = kept) => read.resolve(connection),
    emit(patch: Partial<DaemonStatus>) {
      status = { ...status, ...patch };
      for (const listener of listeners) listener(status);
    },
  };
}

describe("the page's daemon hand-off", () => {
  it("a start that fails while the home's files are read refuses the page, which shows the failure", async () => {
    const a = app();
    const asked = a.handoff.page();
    a.emit({ state: "failed", message: "The daemon could not start" });
    a.filesRead();
    await expect(asked).rejects.toThrow("could not start");
    // Refused, not reconnecting: once the daemon runs after a repair, the page reloads.
    expect(a.reloads()).toBe(0);
    a.emit({ state: "running" });
    expect(a.reloads()).toBe(1);
  });

  it("a start that fails after the page opened on what the home kept reloads the page", async () => {
    const a = app();
    const asked = a.handoff.page();
    a.filesRead();
    expect(await asked).toEqual(kept);
    a.emit({ state: "failed", message: "The daemon could not start" });
    expect(a.reloads()).toBe(1);
  });

  it("a daemon that runs while the files are read hands the page the real target", async () => {
    const a = app();
    const asked = a.handoff.page();
    a.emit({ state: "running" });
    a.filesRead();
    expect(await asked).toEqual(real);
    expect(a.reloads()).toBe(0);
  });

  it("a page that opened early follows the daemon without reloading once it runs", async () => {
    const a = app();
    const asked = a.handoff.page();
    a.filesRead();
    await asked;
    a.emit({ state: "running" });
    // A later crash is the reconnecting notice's to show, not a reload.
    a.emit({ state: "restarting", message: "The daemon exited" });
    expect(a.reloads()).toBe(0);
  });

  it("quitting while the page opened early does not reload it", async () => {
    const a = app();
    const asked = a.handoff.page();
    a.filesRead();
    await asked;
    a.emit({ state: "stopping" });
    a.emit({ state: "stopped" });
    expect(a.reloads()).toBe(0);
  });
});
