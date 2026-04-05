import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, vi } from "vitest";

import { resolveBaseDir } from "./os-jank";

afterEach(() => {
  vi.restoreAllMocks();
});

it.layer(NodeServices.layer)("resolveBaseDir", (it) => {
  it.effect("uses the default .ace base dir when unset", () =>
    Effect.gen(function* () {
      const fakeHome = path.join(os.tmpdir(), "ace-os-jank-home");

      vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

      const resolved = yield* resolveBaseDir(undefined);
      expect(resolved).toBe(path.join(fakeHome, ".ace"));
    }),
  );

  it.effect("expands home-relative overrides", () =>
    Effect.gen(function* () {
      const fakeHome = path.join(os.tmpdir(), "ace-os-jank-home");

      vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

      const resolved = yield* resolveBaseDir("~/custom-state");
      expect(resolved).toBe(path.join(fakeHome, "custom-state"));
    }),
  );
});
