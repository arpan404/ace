import { expect, test } from "vitest";
import {
  daemonLockedUse,
  pendingPrivilegedReason,
  pendingPrivilegedRunner,
} from "./locked-use-installer.ts";

/** The intent store: locked use never requested. */
const settings = { get: async () => ({ value: false }) } as never;

test("without a privileged runner, detection reports it cannot install", async () => {
  const installer = daemonLockedUse({ platform: "darwin", env: {}, settings });
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
  });
});

test("without a privileged runner, an install reports it cannot install", async () => {
  const installer = daemonLockedUse({ platform: "darwin", env: {}, settings });
  expect((await installer.install()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
  });
});

test("the pending runner is what makes detection unavailable", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    settings,
    runner: pendingPrivilegedRunner,
  });
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
  });
});

test("with a runner, an empty Mac with no intent stays off", async () => {
  const installer = daemonLockedUse({
    platform: "darwin",
    env: {},
    settings,
    runner: { install: () => Promise.resolve(), remove: () => Promise.resolve() },
  });
  expect((await installer.detectStatus()).status).toEqual({ state: "off" });
});

test("without a privileged runner, a stored intent never flips the row on", async () => {
  const wanted = { get: async () => ({ value: true }) } as never;
  const installer = daemonLockedUse({ platform: "darwin", env: {}, settings: wanted });
  // The row's "Check again" re-reads: it must still report it cannot install, not approval waiting.
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
  });
  expect((await installer.detectStatus()).status).toEqual({
    state: "installFailed",
    reason: pendingPrivilegedReason,
  });
});

test("without a privileged runner, removing nothing installed is a quiet off", async () => {
  const installer = daemonLockedUse({ platform: "darwin", env: {}, settings });
  expect((await installer.remove()).status).toEqual({ state: "off" });
});
