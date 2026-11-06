import { expect, test } from "vitest";
import {
  desktopAccessFailure,
  hostPermissions,
  unavailablePermissions,
} from "./permission-model.ts";

test.each(["darwin", "linux", "win32"] as const)(
  "%s preserves old helper authority without inventing platform grants",
  (platform) => {
    const result = hostPermissions({ screenRecording: true, accessibility: false }, platform);
    expect(result.screenRecording).toBe(true);
    expect(result.accessibility).toBe(false);
    expect(result.platform).toBe(platform === "darwin" ? undefined : platform);
    expect(result.requirements?.[0]?.state).toBe(platform === "darwin" ? undefined : "unknown");
  },
);

test.each(["linux", "win32"] as const)(
  "%s names the requirement that blocks desktop access",
  (platform) => {
    const facts = hostPermissions(
      {
        screenRecording: false,
        accessibility: false,
        requirements: [
          {
            kind: "session",
            state: "blocked",
            title: "Session",
            message: "Sign in to the desktop.",
          },
        ],
      },
      platform,
    );
    expect(desktopAccessFailure(facts)).toBe(
      `${platform === "linux" ? "Linux" : "Windows"} desktop access denied. Sign in to the desktop.`,
    );
    expect(unavailablePermissions(platform, "Log in to Wayland").requirements?.[0]?.message).toBe(
      "Log in to Wayland",
    );
  },
);

test("portable Windows permission statuses retain denied input", () => {
  expect(hostPermissions({ screen: "n/a", input: "denied" }, "win32")).toMatchObject({
    screenRecording: true,
    accessibility: false,
    platform: "win32",
  });
});

test("macOS retains the existing Screen Recording and Accessibility failures", () => {
  expect(desktopAccessFailure({ screenRecording: false, accessibility: true })).toBe(
    "Screen Recording permission denied",
  );
  expect(
    desktopAccessFailure({ platform: "darwin", screenRecording: true, accessibility: false }),
  ).toBe("macOS permission denied");
});
