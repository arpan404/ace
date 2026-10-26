import { expect, it } from "vitest";
import { readSimulatorScreens, touchTarget } from "./simulator-screens.ts";

/** `devicectl device info displays --json-output` for an unfolded iPhone Duo, trimmed. */
const duo = (innerLit: boolean) => ({
  result: {
    backlightState: "on",
    displays: [
      { displayId: 1, name: "LCD", nativeSize: [1398, 2034], primary: true, active: !innerLit },
      { displayId: 3, name: "LCD-1", nativeSize: [2007, 2853], primary: false, active: innerLit },
    ],
  },
});
const phone = { result: { displays: [{ displayId: 1, nativeSize: [1206, 2622], active: true }] } };

it("a touch on an iPhone Duo goes to the screen its picture shows", () => {
  const screens = readSimulatorScreens(duo(true));
  // The encoder rounds the inner panel to even pixels.
  expect(touchTarget(screens, { width: 2006, height: 2852 })).toBe(3);
  expect(touchTarget(screens, { width: 1398, height: 2034 })).toBe(1);
});

it("before there is a picture, a touch goes to the lit screen", () => {
  expect(touchTarget(readSimulatorScreens(duo(true)), undefined)).toBe(3);
  expect(touchTarget(readSimulatorScreens(duo(false)), undefined)).toBe(1);
});

it("a phone with one screen, or a report devicectl couldn't give, touches the main screen", () => {
  expect(touchTarget(readSimulatorScreens(phone), { width: 1206, height: 2622 })).toBe(0);
  expect(touchTarget(readSimulatorScreens("not json"), undefined)).toBe(0);
});
