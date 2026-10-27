import { describe, expect, it } from "vitest";
import type { AppUpdateReport } from "@ace/protocol";
import type { UpdateStatus } from "../../shared/contract.ts";
import { UpdateReporter } from "./update-report.ts";

const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  state: "current",
  currentVersion: "1.4.1",
  version: null,
  releaseUrl: null,
  inPlace: true,
  percent: null,
  waiting: 0,
  notes: [],
  olderReleases: 0,
  error: null,
  ...patch,
});

/** A daemon that keeps what it was told and can refuse while it is down. */
function daemon() {
  const told: (AppUpdateReport | "withdrawn")[] = [];
  let up = true;
  const timers: { run(): void; cancelled: boolean }[] = [];
  const reporter = new UpdateReporter({
    send: async (report) => {
      if (!up) throw new Error("connect ECONNREFUSED");
      told.push(report);
    },
    withdraw: async () => {
      if (!up) throw new Error("connect ECONNREFUSED");
      told.push("withdrawn");
    },
    log: () => {},
    timers: {
      set: (_ms, run) => {
        const timer = { run, cancelled: false };
        timers.push(timer);
        return () => (timer.cancelled = true);
      },
    },
  });
  /** The renewal period passes once. */
  const renew = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
  };
  return { told, reporter, down: (on: boolean) => (up = !on), renew };
}

describe("app update reporting", () => {
  it("tells the daemon once it runs, then on each change, never the same report twice", async () => {
    // Changes that arrive together send only the latest.
    const { told, reporter } = daemon();
    reporter.status(status());
    await reporter.settled();
    expect(told).toEqual([]);
    reporter.connected(true);
    reporter.status(status());
    reporter.status(status({ state: "checking" }));
    await reporter.settled();
    expect(told).toEqual([
      {
        version: "1.4.1",
        available: null,
        downloaded: false,
        restartRequired: false,
        releaseUrl: null,
      },
    ]);
    const url = "https://github.com/arpan404/ace/releases/tag/v1.4.2";
    reporter.status(status({ state: "available", version: "1.4.2", releaseUrl: url }));
    await reporter.settled();
    reporter.status(status({ state: "downloading", version: "1.4.2", releaseUrl: url }));
    reporter.status(status({ state: "downloaded", version: "1.4.2", releaseUrl: url }));
    await reporter.settled();
    expect(told.slice(1)).toEqual([
      {
        version: "1.4.1",
        available: "1.4.2",
        downloaded: false,
        restartRequired: false,
        releaseUrl: url,
      },
      {
        version: "1.4.1",
        available: "1.4.2",
        downloaded: true,
        restartRequired: true,
        releaseUrl: url,
      },
    ]);
  });

  it("an update that can't install in place never asks for a restart", async () => {
    const { told, reporter } = daemon();
    reporter.connected(true);
    reporter.status(status({ state: "downloaded", version: "1.4.2", inPlace: false }));
    await reporter.settled();
    expect(told.at(-1)).toMatchObject({ downloaded: true, restartRequired: false });
  });

  it("a restarted daemon hears the report again, and a failed send is retried on reconnect", async () => {
    const { told, reporter, down } = daemon();
    reporter.connected(true);
    reporter.status(status());
    await reporter.settled();
    reporter.connected(false);
    reporter.connected(true);
    await reporter.settled();
    expect(told).toHaveLength(2);
    down(true);
    reporter.status(status({ state: "available", version: "1.4.2" }));
    await reporter.settled();
    expect(told).toHaveLength(2);
    down(false);
    reporter.connected(false);
    reporter.connected(true);
    await reporter.settled();
    expect(told.at(-1)).toMatchObject({ available: "1.4.2" });
  });

  it("quitting takes the report back, and nothing is sent after", async () => {
    const { told, reporter } = daemon();
    reporter.connected(true);
    reporter.status(status({ state: "downloaded", version: "1.4.2" }));
    await reporter.settled();
    await reporter.withdraw();
    reporter.status(status({ state: "current" }));
    reporter.connected(false);
    reporter.connected(true);
    await reporter.settled();
    expect(told.at(-1)).toBe("withdrawn");
    expect(told).toHaveLength(2);
  });

  it("an app that never reported has nothing to withdraw", async () => {
    const { told, reporter } = daemon();
    reporter.connected(true);
    await reporter.withdraw();
    expect(told).toEqual([]);
  });

  it("sends the same report again each renewal, so a daemon that dropped it hears it back", async () => {
    const { told, reporter, renew } = daemon();
    reporter.connected(true);
    reporter.status(status({ state: "downloaded", version: "1.4.2" }));
    await reporter.settled();
    renew();
    await reporter.settled();
    renew();
    await reporter.settled();
    expect(told).toHaveLength(3);
    expect(told[2]).toEqual(told[0]);
  });

  it("stops renewing once the daemon goes or the app quits", async () => {
    const { told, reporter, renew } = daemon();
    reporter.connected(true);
    reporter.status(status());
    await reporter.settled();
    reporter.connected(false);
    renew();
    await reporter.settled();
    reporter.connected(true);
    await reporter.settled();
    await reporter.withdraw();
    renew();
    await reporter.settled();
    expect(told).toEqual([told[0], told[0], "withdrawn"]);
  });
});
