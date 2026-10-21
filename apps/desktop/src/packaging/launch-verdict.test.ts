import { expect, it } from "vitest";
import { launchVerdict } from "./launch-verdict.ts";

const daemon = '[info] daemon: ace daemon: ws://127.0.0.1:<ENV> {"stream":"stdout"}';
const checking = "[info] updates: updater: Checking for update";

it("passes once the daemon serves and an update check has started, even if the check fails", () => {
  expect(
    launchVerdict([
      daemon,
      checking,
      "[warn] updates: Update check failed: Cannot find latest-mac.yml in the latest release",
    ]),
  ).toEqual({ state: "passed" });
});

it("keeps waiting while the daemon or the update check has not shown up", () => {
  expect(launchVerdict([])).toEqual({
    state: "waiting",
    missing: ["the daemon serving", "an update check starting"],
  });
  expect(launchVerdict([daemon])).toEqual({
    state: "waiting",
    missing: ["an update check starting"],
  });
});

it("fails a launch whose main process crashed before the daemon started (0.0.3)", () => {
  const verdict = launchVerdict([
    "(node:20532) UnhandledPromiseRejectionWarning: TypeError: Cannot read properties of undefined (reading 'set')",
  ]);
  expect(verdict).toMatchObject({ state: "failed", reason: expect.stringContaining("'set'") });
});

it("fails a launch whose daemon could not start, even after the updater ran", () => {
  expect(
    launchVerdict([checking, "[error] desktop: Daemon start failed: spawn ENOENT"]),
  ).toMatchObject({ state: "failed" });
});
