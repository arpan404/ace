import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { deriveServerPaths } from "./config";

it.layer(NodeServices.layer)("deriveServerPaths keeps dev web on shared userdata", (it) => {
  it.effect("uses userdata for dev web mode", () =>
    Effect.gen(function* () {
      const baseDir = path.join(os.tmpdir(), "ace-config-dev-web");
      const derived = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5777"), "web");

      assert.equal(derived.stateDir, path.join(baseDir, "userdata"));
      assert.equal(derived.dbPath, path.join(baseDir, "userdata", "state.sqlite"));
    }),
  );

  it.effect("keeps isolated desktop state for dev desktop mode", () =>
    Effect.gen(function* () {
      const baseDir = path.join(os.tmpdir(), "ace-config-dev-desktop");
      const derived = yield* deriveServerPaths(
        baseDir,
        new URL("http://127.0.0.1:5777"),
        "desktop",
      );

      assert.equal(derived.stateDir, path.join(baseDir, "desktop"));
      assert.equal(derived.dbPath, path.join(baseDir, "desktop", "state.sqlite"));
    }),
  );
});
