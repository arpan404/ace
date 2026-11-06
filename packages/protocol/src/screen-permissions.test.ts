import { expect, test } from "vitest";
import { z } from "zod";
import { ScreenPermissions } from "./screen-base.ts";
import { DevicePermissions } from "./devices.ts";
const oldPermissions = z.object({ screenRecording: z.boolean(), accessibility: z.boolean() });
const old = { screenRecording: true, accessibility: false };

test("new clients read older daemon replies without requiring platform fields", () => {
  expect(ScreenPermissions.parse(old)).toEqual(old);
  expect(DevicePermissions.parse(old)).toEqual(old);
});

test.each(["darwin", "linux", "win32"])(
  "old clients can read %s replies and future requirement facts survive new clients",
  (platform) => {
    const reply = {
      ...old,
      platform,
      requirements: [
        {
          kind: "futureRequirement",
          state: "futureState",
          title: "Future access",
          message: "Check the host",
          futureFact: { value: true },
        },
      ],
    };
    expect(oldPermissions.parse(reply)).toEqual(old);
    expect(ScreenPermissions.parse(reply)).toEqual(reply);
    expect(DevicePermissions.parse(reply)).toEqual(reply);
  },
);
