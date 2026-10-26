import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { localDoctorChecks, repairDoctor } from "../doctor-repairs.ts";
import { doctorFeatures } from "./features.ts";
import { cliOrigin } from "./install-versions.ts";
import { doctorTestContext } from "./test-support.ts";

const windows = process.platform === "win32";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const signal = new AbortController().signal;

it.runIf(windows)(
  "on Windows, every doctor feature check finishes with ace stopped, and none fails",
  async () => {
    const { context, cleanup } = await doctorTestContext({
      env: { ...process.env },
      platform: "win32",
    });
    cleanups.push(cleanup);
    const results: { id: string; status: string; message: string }[] = [];
    for (const feature of doctorFeatures)
      for (const check of feature.checks(context)) {
        const result = await check.run(signal);
        results.push({ id: check.id, status: result.status, message: result.message });
      }
    expect(results.filter((result) => result.status === "fail")).toEqual([]);
    expect(results.every((result) => result.message.length > 0)).toBe(true);
    const ids = results.map((result) => result.id);
    expect(ids).toEqual(expect.arrayContaining(["remote.access", "install.android"]));
    // Linux packages and macOS grants don't apply; Windows says why computer use needs none.
    expect(ids.some((id) => id.startsWith("linux."))).toBe(false);
    expect(ids.filter((id) => id.startsWith("computer."))).toEqual(["computer.grants"]);
  },
);

it.runIf(windows)(
  "on Windows, doctor --fix recreates a missing logs folder and then reads both folders as fine",
  async () => {
    const { dataDir, cleanup } = await doctorTestContext();
    cleanups.push(cleanup);
    await rm(join(dataDir, "logs"), { recursive: true, force: true });
    const before = await Promise.all(
      localDoctorChecks(dataDir, undefined).map((check) => check.run(signal)),
    );
    expect(before.map((result) => result.status)).toEqual(["ok", "warn"]);
    const repairs = await repairDoctor(
      dataDir,
      {
        at: 0,
        checks: [{ id: "logs.directory", status: "warn", message: "missing", fix: "" }],
      },
      undefined,
    );
    expect(repairs).toEqual([
      { id: "logs.directory", status: "fixed", message: "Log folder: owner access restored" },
    ]);
    expect((await stat(join(dataDir, "logs"))).isDirectory()).toBe(true);
    const after = await Promise.all(
      localDoctorChecks(dataDir, undefined).map((check) => check.run(signal)),
    );
    expect(after.map((result) => result.status)).toEqual(["ok", "ok"]);
  },
);

it.runIf(windows)("on Windows, an installed release's ace command reports its version", () => {
  const entry = "C:\\Users\\me\\.ace\\releases\\0.4.2-win32-arm64\\ace.mjs";
  expect(cliOrigin(entry)).toEqual({ kind: "release", version: "0.4.2" });
  expect(cliOrigin("C:\\Users\\me\\src\\ace\\apps\\daemon\\src\\ace.mjs")).toBeUndefined();
});
