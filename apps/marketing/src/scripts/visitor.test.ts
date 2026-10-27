import { expect, test } from "vitest";
import { archOf, platformOf } from "./visitor.ts";

const macChrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const windows =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const linuxArm = "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0";
const iphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const android = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile";

test("desktop systems are told apart, and phones get no desktop download", () => {
  expect(platformOf(macChrome)).toBe("mac");
  expect(platformOf(windows)).toBe("windows");
  expect(platformOf(linuxArm)).toBe("linux");
  expect(platformOf(iphone)).toBeUndefined();
  expect(platformOf(android)).toBeUndefined();
});

test("an Apple-silicon Mac is recognised from client hints despite its Intel user agent", () => {
  expect(archOf({ architecture: "arm", bitness: "64" }, macChrome)).toBe("arm64");
  expect(archOf({ architecture: "x86", bitness: "64" }, macChrome)).toBe("x64");
});

test("a Mac browser without client hints leaves the chip unknown instead of guessing Intel", () => {
  expect(archOf(undefined, macChrome)).toBeUndefined();
});

test("Linux and Windows user agents name their chip when there are no hints", () => {
  expect(archOf(undefined, linuxArm)).toBe("arm64");
  expect(archOf(undefined, windows)).toBe("x64");
});
