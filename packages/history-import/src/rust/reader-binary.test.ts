import { expect, test } from "vitest";
import { findHistoryBinary } from "./reader-binary.ts";

test("a release runs the history reader it carries under its shipped name", () => {
  expect(
    findHistoryBinary(
      "darwin",
      { ACE_HISTORY_PATH: "/tmp/elsewhere" },
      "/App/Resources/daemon/ace.mjs",
      (path) =>
        path === "/App/Resources/history/ace History Service" ||
        path === "/App/Resources/daemon/desktop-app.json",
    ),
  ).toBe("/App/Resources/history/ace History Service");
  expect(
    findHistoryBinary("linux", {}, "/rel/ace.mjs", (path) => path === "/rel/history/ace-history"),
  ).toBeUndefined();
});

test("a source checkout runs Cargo's build under the crate's own name", () => {
  const found = findHistoryBinary("linux", {}, "/src/apps/daemon/src/cli.ts", (path) =>
    path.endsWith("/native/history/target/release/ace-history"),
  );
  expect(found).toMatch(/\/native\/history\/target\/release\/ace-history$/);
});
