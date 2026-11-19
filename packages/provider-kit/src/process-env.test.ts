import { expect, test } from "vitest";
import { environmentLaunchError, launchLimits } from "./process-env.ts";
import { blockOfBytes, variableOfBytes } from "./testing/env-block.ts";

test.each(["linux", "darwin", "win32"] as const)(
  "on %s a variable exactly at the per-string limit launches and one byte more doesn't",
  (platform) => {
    const { string } = launchLimits(platform);
    expect(environmentLaunchError(variableOfBytes("AT_LIMIT", string), platform)).toBeUndefined();
    expect(environmentLaunchError(variableOfBytes("AT_LIMIT", string + 1), platform)).toMatch(
      /AT_LIMIT/,
    );
  },
);

test("Linux counts a variable in UTF-8 bytes, not characters", () => {
  const { string } = launchLimits("linux");
  // Each "é" is two bytes: this value is half the limit in characters, the whole of it in bytes.
  const value = "é".repeat((string - "E=".length) / 2);
  expect(environmentLaunchError({ E: value }, "linux")).toMatch(/E/);
  expect(environmentLaunchError({ E: value.slice(1) }, "linux")).toBeUndefined();
});

test("Windows counts a variable in UTF-16 units", () => {
  const { string } = launchLimits("win32");
  const value = "é".repeat(string - "E=".length - 1);
  expect(environmentLaunchError({ E: value }, "win32")).toBeUndefined();
  expect(environmentLaunchError({ E: `${value}é` }, "win32")).toMatch(/E/);
});

test.each(["linux", "darwin"] as const)(
  "on %s a block exactly at the environment budget launches and one byte more doesn't",
  (platform) => {
    const { string, block } = launchLimits(platform);
    const env = blockOfBytes(block, Math.min(string, 100_000));
    expect(environmentLaunchError(env, platform)).toBeUndefined();
    const first = Object.keys(env)[0] ?? "";
    expect(environmentLaunchError({ ...env, [first]: `${env[first]}x` }, platform)).toMatch(
      /environment/,
    );
  },
);

test("a masked variable is not part of the launched block", () => {
  const { string } = launchLimits("linux");
  expect(
    environmentLaunchError({ ...variableOfBytes("A", string), MASKED: undefined }, "linux"),
  ).toBeUndefined();
});
