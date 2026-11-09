import { expect, test } from "vitest";
import { withoutBenchWorkerPreload, workerPreloadVariable } from "./worker.ts";

test("a production launch drops a benchmark's worker preload and keeps everything else", () => {
  const env = withoutBenchWorkerPreload({
    PATH: "/usr/bin",
    ACE_HOME: "/Users/person/.ace",
    [workerPreloadVariable]: "/repo/apps/daemon/bench/telemetry.mjs",
  });
  expect(env).toEqual({ PATH: "/usr/bin", ACE_HOME: "/Users/person/.ace" });
});
