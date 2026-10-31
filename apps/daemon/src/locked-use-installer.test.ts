import { expect, test } from "vitest";
import {
  emptyLayout,
  fakeMac,
  fakeTeam,
  installedLayout,
} from "@ace/screen/testing/locked-use-host";
import {
  daemonLockedUse,
  pendingPrivilegedReason,
  pendingPrivilegedRunner,
} from "./locked-use-installer.ts";

/** The intent store: locked use never requested. */
const settings = { get: async () => ({ value: false }) };

test("without a privileged runner, detection reports it cannot install", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    host: fakeMac(emptyLayout()).host,
    settings,
  });
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
    unavailable: true,
  });
});

test("without a privileged runner, an install reports it cannot install", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    host: fakeMac(emptyLayout()).host,
    settings,
  });
  expect((await installer.install()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
    unavailable: true,
  });
});

test("the pending runner is what makes detection unavailable", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    host: fakeMac(emptyLayout()).host,
    settings,
    runner: pendingPrivilegedRunner,
  });
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
    unavailable: true,
  });
});

test("with a runner, an empty Mac with no intent stays off", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    host: fakeMac(emptyLayout()).host,
    settings,
    runner: { install: () => Promise.resolve(), remove: () => Promise.resolve() },
  });
  expect((await installer.detectStatus()).status).toEqual({ state: "off" });
});

test("without a privileged runner, a stored intent never flips the row on", async () => {
  const wanted = { get: async () => ({ value: true }) };
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    host: fakeMac(emptyLayout()).host,
    settings: wanted,
  });
  // The row's "Check again" re-reads: it must still report it cannot install, not approval waiting.
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
    unavailable: true,
  });
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
    unavailable: true,
  });
});

test("without a privileged runner, removing nothing installed is a quiet off", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    host: fakeMac(emptyLayout()).host,
    settings,
  });
  expect((await installer.remove()).status).toEqual({ state: "off" });
});

test("without a privileged runner, a prior installation still reports on", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: { ACE_LOCKED_USE_TEAM: fakeTeam },
    host: fakeMac(installedLayout()).host,
    settings,
  });
  expect((await installer.detectStatus()).status).toEqual({ state: "on" });
  expect((await installer.install()).status).toEqual({ state: "on" });
  await expect(installer.remove()).rejects.toThrow("can't be turned off in this build");
  expect((await installer.detectStatus()).status).toEqual({ state: "on" });
});
