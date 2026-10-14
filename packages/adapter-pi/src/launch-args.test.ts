import { expect, test } from "vitest";
import { piNative } from "@ace/provider-kit/access-modes";
import { piLaunchArgs } from "./launch-args.ts";

test("Pi's Read-only runs its own read-only tool allowlist; Full access leaves its tools alone", () => {
  expect(piLaunchArgs(piNative.readOnly, undefined)).toEqual(["--tools", "read,grep,find,ls"]);
  expect(piLaunchArgs(piNative.unrestricted, undefined)).toEqual([]);
  expect(piLaunchArgs(undefined, undefined)).toEqual([]);
});

test("an effort is Pi's thinking level, and an unknown mode or level is refused", () => {
  expect(piLaunchArgs(piNative.unrestricted, "xhigh")).toEqual(["--thinking", "xhigh"]);
  expect(() => piLaunchArgs("plan", undefined)).toThrow("Pi cannot run");
  expect(() => piLaunchArgs(undefined, "ultra")).toThrow();
});
