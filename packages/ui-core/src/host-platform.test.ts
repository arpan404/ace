import { expect, test } from "vitest";
import { hostPlatform } from "./host-platform.ts";

test("the three systems clients know read as themselves", () => {
  expect(hostPlatform("darwin")).toBe("darwin");
  expect(hostPlatform("linux")).toBe("linux");
  expect(hostPlatform("win32")).toBe("win32");
});

test("a platform this client doesn't know reads as absent, as an older daemon's missing one does", () => {
  expect(hostPlatform("freebsd")).toBeUndefined();
  expect(hostPlatform("Darwin")).toBeUndefined();
  expect(hostPlatform(undefined)).toBeUndefined();
});
