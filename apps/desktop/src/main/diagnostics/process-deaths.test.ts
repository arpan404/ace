import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopLog, type LogLevel } from "../log/desktop-log.ts";
import { crashDumps, startCrashReporter } from "./crash-reporter.ts";
import { processDeaths } from "./process-deaths.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function crashpad(): string {
  const root = mkdtempSync(join(tmpdir(), "ace-crashpad-"));
  roots.push(root);
  return root;
}
/** A minidump as Crashpad leaves it, modified at `at` (epoch ms). */
function dump(directory: string, stage: string, name: string, at: number): string {
  mkdirSync(join(directory, stage), { recursive: true });
  const path = join(directory, stage, name);
  writeFileSync(path, "MDMP");
  utimesSync(path, at / 1000, at / 1000);
  return path;
}

const NOW = Date.parse("2026-10-19T23:17:47Z");

/** Process deaths written through the real desktop log; records captured as written. */
function watch(directory: string) {
  const records: Array<{ level: LogLevel; text: string }> = [];
  const later: Array<() => void> = [];
  const log = createDesktopLog({
    now: () => NOW,
    console: (level, text) => records.push({ level, text }),
    // Temp folders are redacted in the real log; these paths are the test's own.
    redact: (text) => text,
  })("process");
  const deaths = processDeaths({
    log,
    now: () => NOW,
    dumps: (since) => crashDumps(directory, since),
    schedule: (callback) => later.push(callback),
  });
  return { deaths, records, later };
}

describe("process deaths in the desktop log", () => {
  it("writes a crashed GPU process with its reason, exit code and crash dump", async () => {
    const directory = crashpad();
    const path = dump(directory, "completed", "gpu.dmp", NOW - 1_000);
    const { deaths, records } = watch(directory);
    await deaths.child({ type: "GPU", reason: "crashed", exitCode: 11 });
    expect(records).toEqual([
      {
        level: "error",
        text: `[error] process: GPU process gone: crashed ${JSON.stringify({
          type: "GPU",
          reason: "crashed",
          exitCode: 11,
          serviceName: null,
          name: null,
          minidump: path,
        })}`,
      },
    ]);
  });

  it("names a killed network service and keeps an old dump out of it", async () => {
    const directory = crashpad();
    dump(directory, "completed", "last-week.dmp", NOW - 7 * 24 * 3_600_000);
    const { deaths, records } = watch(directory);
    await deaths.child({
      type: "Utility",
      reason: "killed",
      exitCode: 9,
      serviceName: "network.mojom.NetworkService",
      name: "Network Service",
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("error");
    expect(records[0]?.text).toContain("Network Service process gone: killed");
    expect(records[0]?.text).toContain('"serviceName":"network.mojom.NetworkService"');
    expect(records[0]?.text).not.toContain("minidump");
  });

  it("records a clean helper exit at info, without looking for a dump", async () => {
    const directory = crashpad();
    dump(directory, "pending", "other.dmp", NOW);
    const { deaths, records, later } = watch(directory);
    await deaths.child({ type: "Utility", reason: "clean-exit", exitCode: 0, name: "Audio" });
    expect(records.map((record) => record.level)).toEqual(["info"]);
    expect(records[0]?.text).not.toContain("minidump");
    expect(later).toHaveLength(0);
  });

  it("reports a dump Crashpad finishes after the death in a follow-up record", async () => {
    const directory = crashpad();
    const { deaths, records, later } = watch(directory);
    await deaths.renderer("main", { reason: "oom", exitCode: 0 });
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toContain("main renderer gone: oom");
    expect(records[0]?.level).toBe("error");
    const path = dump(directory, "new", "late.dmp", NOW + 500);
    for (const run of later) run();
    await expect.poll(() => records.length).toBe(2);
    expect(records[1]?.level).toBe("info");
    expect(records[1]?.text).toContain("Crash dump written: main renderer gone: oom");
    expect(records[1]?.text).toContain(`"minidump":${JSON.stringify(path)}`);
  });

  it("credits one dump to one death only", async () => {
    const directory = crashpad();
    const path = dump(directory, "completed", "gpu.dmp", NOW);
    const { deaths, records } = watch(directory);
    await deaths.child({ type: "GPU", reason: "crashed", exitCode: 11 });
    await deaths.renderer("secondary", { reason: "crashed", exitCode: 11 });
    expect(records[0]?.text).toContain(path);
    expect(records[1]?.text).not.toContain("minidump");
  });

  it("still records the death when the dump folder cannot be read", async () => {
    const { deaths, records } = watch(join(crashpad(), "missing"));
    await deaths.child({ type: "GPU", reason: "launch-failed", exitCode: 1 });
    expect(records.map((record) => record.level)).toEqual(["error"]);
  });
});

describe("crash reporter", () => {
  it("keeps dumps in the app's data folder and never uploads them", () => {
    const calls: unknown[] = [];
    const directory = startCrashReporter(
      {
        setPath: (name, path) => calls.push({ setPath: name, path }),
        start: (options) => calls.push({ start: options }),
      },
      "/data/ace",
    );
    expect(directory).toBe("/data/ace/Crashpad");
    // The folder must be set before Crashpad starts, or dumps go to Electron's default.
    expect(calls).toEqual([
      { setPath: "crashDumps", path: "/data/ace/Crashpad" },
      { start: { uploadToServer: false, compress: false } },
    ]);
  });
});
