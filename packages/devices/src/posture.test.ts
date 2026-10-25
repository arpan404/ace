import { expect, it } from "vitest";
import { readPosture } from "./posture.ts";

/** A `devicectl device info displays` report shaped like an iPhone Duo's (cover, then inner). */
function duo(cover: { active: boolean; backlight: string }, inner: typeof cover) {
  return {
    info: { outcome: "success" },
    result: {
      backlightState: "activeOn",
      displays: [
        {
          name: "LCD",
          primary: true,
          active: cover.active,
          backlightState: cover.backlight,
          nativeSize: [1398, 2034],
        },
        {
          name: "LCD-1",
          primary: false,
          active: inner.active,
          backlightState: inner.backlight,
          nativeSize: [2007, 2853],
        },
      ],
    },
  };
}

it("a lit cover screen reads as closed, even while the inner one is still marked active", () => {
  expect(
    readPosture(duo({ active: false, backlight: "activeOn" }, { active: true, backlight: "off" })),
  ).toBe("closed");
});

it("a lit inner screen reads as open", () => {
  expect(
    readPosture(duo({ active: false, backlight: "off" }, { active: true, backlight: "activeOn" })),
  ).toBe("open");
});

it("the inner screen stays half open when half open was the last posture asked for", () => {
  const report = duo({ active: false, backlight: "off" }, { active: true, backlight: "activeOn" });
  expect(readPosture(report, "partiallyOpen")).toBe("partiallyOpen");
  expect(readPosture(report, "closed")).toBe("open");
});

it("with both screens asleep the active screen decides", () => {
  expect(
    readPosture(duo({ active: true, backlight: "off" }, { active: false, backlight: "off" })),
  ).toBe("closed");
  expect(
    readPosture(duo({ active: false, backlight: "off" }, { active: true, backlight: "off" })),
  ).toBe("open");
});

it("a device with one screen, or a report that can't be read, has no posture", () => {
  const phone = {
    result: {
      displays: [{ name: "LCD", primary: true, active: true, backlightState: "activeOn" }],
    },
  };
  expect(readPosture(phone)).toBeUndefined();
  expect(readPosture({ error: "device not found" })).toBeUndefined();
  expect(readPosture("not json")).toBeUndefined();
});
