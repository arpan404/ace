import { expect, test } from "vitest";
import { bunMismatch } from "./runtimes.ts";

const pinned = JSON.stringify({ packageManager: "bun@1.4.4" });

test("tests run only on the Bun release package.json pins", () => {
  expect(bunMismatch(pinned, "1.4.4")).toBeUndefined();
  expect(bunMismatch(pinned, "1.4.0")).toMatch(/Bun 1\.4\.0.*pins Bun 1\.4\.4/);
  expect(bunMismatch(pinned, "1.5.0")).toMatch(/pins Bun 1\.4\.4/);
});

test("a Node run is never refused for its Bun version", () => {
  expect(bunMismatch(pinned, undefined)).toBeUndefined();
});

test("a package.json without a Bun pin is refused rather than trusted", () => {
  expect(bunMismatch(JSON.stringify({ packageManager: "npm@11.0.0" }), "1.4.4")).toMatch(
    /doesn't name a Bun version/,
  );
});
