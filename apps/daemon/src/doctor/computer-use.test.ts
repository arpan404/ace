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

it("Windows requirements stay unverified when the helper cannot report them", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "win32" });
  cleanups.push(cleanup);
  const checks = computerUseFeature().checks(context);
  expect(checks.map((check) => check.id)).toEqual(["computer.grants"]);
  const [grants] = checks;
  expect(await grants?.run(new AbortController().signal)).toMatchObject({
    status: "warn",
    message: expect.stringContaining("could not be checked"),
  });
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

it("Windows doctor reports a blocked interactive desktop with the host fix", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "win32" });
  cleanups.push(cleanup);
  const result = await verdicts(
    context,
    running({
      kind: "known",
      enabled: true,
      permissions: {
        screenRecording: false,
        accessibility: false,
        platform: "win32",
        requirements: [
          {
            kind: "interactiveDesktop",
            state: "blocked",
            title: "Interactive desktop",
            message: "Unlock Windows and dismiss UAC.",
          },
        ],
      },
    }),
  );
  expect(result.get("computer.grants")).toMatchObject({
    status: "warn",
    message: "Unlock Windows and dismiss UAC.",
  });
});

it("an older Windows helper cannot make an unverified desktop look ready", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "win32" });
  cleanups.push(cleanup);
  const result = await verdicts(
    context,
    running({
      kind: "known",
      enabled: true,
      permissions: {
        screenRecording: true,
        accessibility: true,
        platform: "win32",
        requirements: [
          {
            kind: "helperRequirements",
            state: "unknown",
            title: "Requirements",
            message: "Update the helper.",
          },
        ],
      },
    }),
  );
  expect(result.get("computer.grants")).toMatchObject({
    status: "warn",
    message: expect.stringContaining("have not been verified"),
  });
});
