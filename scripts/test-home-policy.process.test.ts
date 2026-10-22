import { join } from "node:path";
import { expect, test } from "vitest";
import { isolatedTestEnvironment } from "./test-home-policy.ts";

const desktop = {
  PATH: "/usr/bin",
  XDG_RUNTIME_DIR: "/tmp/ace-e2e-rt.abc",
  XDG_DATA_DIRS: "/usr/local/share:/usr/share",
  XDG_SESSION_TYPE: "wayland",
  XDG_CURRENT_DESKTOP: "GNOME",
  XDG_CONFIG_HOME: "/home/person/.config",
  ACE_SCREEN_HELPER: "/tmp/ace-e2e-helper.abc/ace-screen-helper-linux",
};
const home = "/tmp/ace-test-homes/worker";

test("an ordinary test run never reaches the person's desktop session or screen helper", () => {
  const env = isolatedTestEnvironment(desktop, home, "/home/person");
  expect(env.XDG_RUNTIME_DIR).toBe(join(home, ".runtime"));
  expect(env.XDG_DATA_DIRS).toBe(join(home, ".local/share"));
  expect(env.XDG_SESSION_TYPE).toBeUndefined();
  expect(env.ACE_SCREEN_HELPER).toBeUndefined();
  expect(env.ACE_LINUX_DESKTOP_E2E).toBeUndefined();
});

test("the Linux desktop run reaches the desktop its runner started, with writable homes still isolated", () => {
  const env = isolatedTestEnvironment(
    { ...desktop, ACE_LINUX_DESKTOP_E2E: "wayland" },
    home,
    "/home/person",
  );
  expect(env).toMatchObject({
    ACE_LINUX_DESKTOP_E2E: "wayland",
    ACE_SCREEN_HELPER: desktop.ACE_SCREEN_HELPER,
    XDG_RUNTIME_DIR: desktop.XDG_RUNTIME_DIR,
    XDG_DATA_DIRS: desktop.XDG_DATA_DIRS,
    XDG_SESSION_TYPE: "wayland",
    XDG_CURRENT_DESKTOP: "GNOME",
    XDG_CONFIG_HOME: join(home, ".config"),
    HOME: home,
  });
});

test("the Android run reaches the SDK its runner points at, with homes still isolated", () => {
  const env = isolatedTestEnvironment(
    {
      ...desktop,
      ACE_ANDROID_E2E_SDK: "/tmp/ace-android-sdk.abc",
    },
    home,
    "/home/person",
  );
  expect(env.ACE_ANDROID_E2E_SDK).toBe("/tmp/ace-android-sdk.abc");
  expect(env.XDG_RUNTIME_DIR).toBe(join(home, ".runtime"));
  expect(env.ANDROID_AVD_HOME).toBe(join(home, ".android/avd"));
});

test("an Android run that boots an AVD reaches the runner's AVD folder and its gpu choice", () => {
  const env = isolatedTestEnvironment(
    {
      ...desktop,
      ACE_ANDROID_E2E_SDK: "/tmp/ace-android-sdk.abc",
      ACE_ANDROID_E2E_BOOT_AVD: "ace_ci",
      ACE_ANDROID_EMULATOR_GPU: "swiftshader_indirect",
    },
    home,
    "/home/person",
  );
  expect(env).toMatchObject({
    ACE_ANDROID_E2E_BOOT_AVD: "ace_ci",
    ACE_ANDROID_EMULATOR_GPU: "swiftshader_indirect",
    ANDROID_AVD_HOME: "/home/person/.android/avd",
    HOME: home,
  });
});
