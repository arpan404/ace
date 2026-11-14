import { expect, test } from "vitest";
import { smokeOptions } from "./smoke-options.ts";

test("the original archive-only invocation needs no desktop or signing credentials", () => {
  expect(smokeOptions(["release"])).toMatchObject({
    root: "release",
    manifestPath: undefined,
    app: undefined,
    authenticode: false,
  });
  expect(smokeOptions(["release", "--unsigned-archive"])).toEqual(smokeOptions(["release"]));
});

test("signed archive checks require both authority inputs and refuse unsigned overrides", () => {
  expect(
    smokeOptions([
      "release",
      "--signed-archive",
      "--manifest",
      "target.json",
      "--public-key",
      "key.pem",
    ]),
  ).toMatchObject({ manifestPath: "target.json", keyPath: "key.pem" });
  for (const args of [
    ["--signed-archive"],
    ["--manifest", "target.json"],
    ["--signed-archive", "--unsigned-archive"],
  ])
    expect(() => smokeOptions(["release", ...args])).toThrow();
});

test("desktop and executable signatures are independent of archive authority", () => {
  expect(
    smokeOptions([
      "release",
      "--unsigned-archive",
      "--desktop",
      "ace.app",
      "--local",
      "--screen-identity",
      "staged.json",
    ]),
  ).toMatchObject({
    app: "ace.app",
    production: false,
    snapshot: "staged.json",
    authenticode: false,
  });
  expect(smokeOptions(["release", "--verify-authenticode"]).authenticode).toBe(true);
});
