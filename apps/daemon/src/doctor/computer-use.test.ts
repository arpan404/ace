import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CheckResult } from "@ace/diagnostics";
import { computerUsePorts, type ScreenFacts } from "./computer-use-facts.ts";
import { computerUseFeature } from "./computer-use.ts";
import type { DoctorContext, DoctorFeature } from "./feature.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const signal = new AbortController().signal;

async function verdicts(context: DoctorContext, feature: DoctorFeature) {
  const results = new Map<string, Omit<CheckResult, "id">>();
  for (const check of feature.checks(context)) results.set(check.id, await check.run(signal));
  return results;
}

const running = (facts: ScreenFacts) =>
  computerUseFeature({ screen: async () => facts, helper: computerUsePorts.helper });

it("computer use has no checks off macOS", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "linux" });
  cleanups.push(cleanup);
  expect(computerUseFeature().checks(context)).toEqual([]);
});

it("a missing grant warns with its System Settings pane while computer use is on", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "darwin" });
  cleanups.push(cleanup);
  const results = await verdicts(
    context,
    running({
      kind: "known",
      enabled: true,
      permissions: { accessibility: false, screenRecording: true },
    }),
  );
  const accessibility = results.get("computer.accessibility");
  expect(accessibility?.status).toBe("warn");
  expect(accessibility?.message).toBe(
    "Ace Screen Helper doesn't have Accessibility, so agents can't click or type in apps",
  );
  expect(accessibility?.fix).toContain("System Settings › Privacy & Security › Accessibility");
  expect(results.get("computer.screen-recording")).toMatchObject({
    status: "ok",
    message: "Screen Recording granted to Ace Screen Helper",
  });
  // The helper answered, so it exists even though doctor can't see where it was installed.
  expect(results.get("computer.helper")?.status).toBe("ok");
});

it("missing grants don't need attention while computer use is off", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "darwin" });
  cleanups.push(cleanup);
  const results = await verdicts(
    context,
    running({
      kind: "known",
      enabled: false,
      permissions: { accessibility: false, screenRecording: false },
    }),
  );
  expect([...results.values()].map((verdict) => verdict.status)).toEqual(["ok", "ok", "ok"]);
});

it("while ace is stopped grants read as unknown, and the installed helper is found", async () => {
  const { context, dataDir, cleanup } = await doctorTestContext({ platform: "darwin" });
  cleanups.push(cleanup);
  const feature = computerUseFeature();

  let results = await verdicts(context, feature);
  expect(results.get("computer.accessibility")).toMatchObject({
    status: "ok",
    message: "Accessibility: unknown while ace is stopped",
  });
  expect(results.get("computer.screen-recording")?.status).toBe("ok");
  expect(results.get("computer.helper")).toMatchObject({
    status: "warn",
    message: "Ace Screen Helper isn't installed, so computer use is unavailable",
  });

  const macos = join(
    dataDir,
    "screen-helper",
    "0123456789abcdef01234567",
    "AceScreenHelper.app",
    "Contents",
    "MacOS",
  );
  await mkdir(macos, { recursive: true });
  await writeFile(join(macos, "ace-screen-helper"), "");
  results = await verdicts(context, feature);
  expect(results.get("computer.helper")?.status).toBe("ok");
  expect(results.get("computer.helper")?.message).toContain(
    "screen-helper/0123456789abcdef01234567/AceScreenHelper.app/Contents/MacOS/ace-screen-helper",
  );
});

it("a daemon started without the helper warns that computer use is unavailable", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "darwin" });
  cleanups.push(cleanup);
  const results = await verdicts(context, running({ kind: "unconfigured" }));
  expect(results.get("computer.helper")).toMatchObject({
    status: "warn",
    message: "ace is running without Ace Screen Helper, so computer use is unavailable",
  });
  expect(results.get("computer.accessibility")?.status).toBe("ok");
});
