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
  const told: AppUpdateReport[] = [];
  let up = true;
  const reporter = new UpdateReporter({
    send: async (report) => {
      if (!up) throw new Error("connect ECONNREFUSED");
      told.push(report);
    },
    log: () => {},
  });
  return { told, reporter, down: (on: boolean) => (up = !on) };
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
});
