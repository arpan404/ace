// SPDX-License-Identifier: Apache-2.0

/**
 * The switch-off platform is today's TypeScript byte for byte: an injected clock must not
 * reach its probes, so timers behave exactly as they did before the port.
 */
import { expect, test } from "vitest";
import { DevicePlatformBase } from "./platform-base.ts";

type Internals = {
  xcode: () => Promise<{ xcrun: string; open: string }>;
  simulators: { list: () => Promise<unknown[]> };
};

test("the switch-off platform's probes get no scheduler, so today's timers stay", async () => {
  let schedule: unknown = "unset";
  const platform = new DevicePlatformBase({
    platform: "darwin",
    home: "/home/a",
    env: {},
    after: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    probe: async (_command, _args, options) => {
      schedule = options?.schedule;
      return { stdout: '{"devices":{}}', stderr: "", code: 0 };
    },
  });
  const internals = platform as unknown as Internals;
  internals.xcode = async () => ({ xcrun: "/xcrun", open: "/open" });
  await internals.simulators.list();
  expect(schedule).toBeUndefined();
});
