import { expect, test } from "vitest";
import { chromeArgs } from "./chrome-flags.ts";

const disabledFeatures = (args: readonly string[]) =>
  args
    .filter((arg) => arg.startsWith("--disable-features="))
    .map((arg) => arg.slice("--disable-features=".length).split(","));

test("features a launch disables join the ones ace's Chrome disables, in the one flag Chrome reads", () => {
  const args = chromeArgs({
    profileDir: "/profile",
    deviceScaleFactor: 1,
    platform: "darwin",
    extra: ["--disable-features=RendererCodeIntegrity,PMProcessPriorityPolicy", "--mute-audio"],
  });
  // Chrome keeps only the last --disable-features, so there must be exactly one.
  expect(disabledFeatures(args)).toEqual([["PMProcessPriorityPolicy", "RendererCodeIntegrity"]]);
  expect(args).toContain("--mute-audio");
});

test("ace's Chrome keeps its processes at normal priority with no extra flags", () => {
  const args = chromeArgs({ profileDir: "/profile", deviceScaleFactor: 2, platform: "linux" });
  expect(disabledFeatures(args)).toEqual([["PMProcessPriorityPolicy"]]);
  expect(args).toContain("--disable-renderer-backgrounding");
});
