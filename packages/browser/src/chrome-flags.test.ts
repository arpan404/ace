import { expect, test } from "vitest";
import { chromeArgs } from "./chrome-flags.ts";
import { emulatedChromeArgs } from "./emulated-chrome.ts";

/**
 * Every `--disable-features` occurrence, bare ones included, as the features each lists. Chrome
 * keeps only the last occurrence, so a launch that works has exactly one.
 */
const disabledFeatures = (args: readonly string[]) =>
  args
    .filter((arg) => /^--?disable-features(=|$)/.test(arg))
    .map((arg) => arg.split("=").slice(1).join("=").split(",").filter(Boolean));

const backgroundSwitches = [
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
];
const launch = (extra: readonly string[] = []) =>
  chromeArgs({ profileDir: "/profile", deviceScaleFactor: 1, platform: "win32", extra });
const x64 = () => "x64";

test("ace's Chrome keeps its processes at normal priority with no extra flags", () => {
  const args = launch();
  expect(disabledFeatures(args)).toEqual([["PMProcessPriorityPolicy"]]);
  for (const flag of backgroundSwitches) expect(args).toContain(flag);
});

test("features a launch disables join the ones ace's Chrome disables, in the one flag Chrome reads", () => {
  const args = launch([
    "--disable-features=RendererCodeIntegrity,PMProcessPriorityPolicy",
    "--mute-audio",
  ]);
  expect(disabledFeatures(args)).toEqual([["PMProcessPriorityPolicy", "RendererCodeIntegrity"]]);
  expect(args).toContain("--mute-audio");
});

test("a bare --disable-features from a launch cannot clear the features ace's Chrome disables", () => {
  const args = launch(["--disable-features", "--disable-features=Translate", "-disable-features"]);
  expect(disabledFeatures(args)).toEqual([["PMProcessPriorityPolicy", "Translate"]]);
  for (const flag of backgroundSwitches) expect(args).toContain(flag);
});

test("an x64 Chrome on ARM64 Windows keeps every disabled feature in its one flag, restart after restart", () => {
  const args = emulatedChromeArgs(
    "chrome.exe",
    launch(["--disable-features=Translate"]),
    "arm64",
    x64,
  );
  expect(disabledFeatures(args)).toEqual([
    ["PMProcessPriorityPolicy", "Translate", "RendererCodeIntegrity"],
  ]);
  // Started again with the same flags (a crash restart): nothing is added twice.
  expect(emulatedChromeArgs("chrome.exe", args, "arm64", x64)).toEqual(args);
  for (const flag of backgroundSwitches) expect(args).toContain(flag);
});

test("a native Chrome's launch flags pass through emulation untouched", () => {
  const args = launch();
  expect(emulatedChromeArgs("chrome.exe", args, "arm64", () => "arm64")).toBe(args);
  expect(emulatedChromeArgs("chrome.exe", args, "x64", () => "x64")).toBe(args);
});
