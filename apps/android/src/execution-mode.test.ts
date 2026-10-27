import { expect, it } from "vitest";
import {
  assertBundleMatchesMode,
  createExecutionModeReader,
  isFixtureMode,
  parseExecutionMode,
} from "./execution-mode.ts";

it("accepts each known native execution mode", () => {
  expect(parseExecutionMode("debug-fixture")).toBe("debug-fixture");
  expect(parseExecutionMode("measurement-fixture")).toBe("measurement-fixture");
  expect(parseExecutionMode("production")).toBe("production");
});

it("rejects unknown, mistyped, and missing native modes", () => {
  for (const value of [
    "Debug-Fixture",
    "release",
    "staging",
    "",
    null,
    undefined,
    0,
    { mode: "debug-fixture" },
    ["production"],
  ]) {
    expect(() => parseExecutionMode(value), JSON.stringify(value)).toThrow();
  }
});

it("fails closed when the native bridge itself is missing", () => {
  const read = createExecutionModeReader(() => {
    throw new Error("Cannot find native module 'AceNative'");
  });
  expect(() => read()).toThrow();
});

it("fails closed when native and JS disagree on the mode", () => {
  const read = createExecutionModeReader(() => "instrumented");
  expect(() => read()).toThrow();
});

it("treats only production as outside the fixture boundary", () => {
  expect(isFixtureMode("debug-fixture")).toBe(true);
  expect(isFixtureMode("measurement-fixture")).toBe(true);
  expect(isFixtureMode("production")).toBe(false);
});

it("requires a development bundle for the debug fixture", () => {
  expect(() => assertBundleMatchesMode("debug-fixture", true)).not.toThrow();
  expect(() => assertBundleMatchesMode("debug-fixture", false)).toThrow();
});

it("requires an optimized bundle for the measurement fixture", () => {
  expect(() => assertBundleMatchesMode("measurement-fixture", false)).not.toThrow();
  expect(() => assertBundleMatchesMode("measurement-fixture", true)).toThrow();
});
