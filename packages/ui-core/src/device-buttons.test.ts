import { expect, test } from "vitest";
import { bodyTurn, deviceButtons, type HardwareButton } from "./device-buttons.ts";

const named = (buttons: HardwareButton[], label: string) => {
  const button = buttons.find((candidate) => candidate.label === label);
  if (!button) throw new Error(`No ${label}`);
  return button;
};
const pressable = (buttons: HardwareButton[]) =>
  buttons.filter((button) => button.key).map((button) => [button.label, button.key, button.edge]);

test("an Android phone's power button sits on its right edge above the volume rocker", () => {
  const buttons = deviceButtons("android-phone", "Pixel 9", 0);
  const power = named(buttons, "Power button");
  const up = named(buttons, "Volume up");
  const down = named(buttons, "Volume down");

  expect([power.edge, up.edge, down.edge]).toEqual(["right", "right", "right"]);
  expect(power.start + power.length).toBeLessThan(up.start);
  // The rocker's halves meet: one piece of metal, pressed at either end.
  expect(up.start + up.length).toBeCloseTo(down.start);
  expect(pressable(buttons)).toEqual([
    ["Power button", "power", "right"],
    ["Volume up", "volumeUp", "right"],
    ["Volume down", "volumeDown", "right"],
  ]);
});

test("an iPhone with the Action button has it above the volume buttons on the left, the side button on the right", () => {
  const buttons = deviceButtons("iphone", "iPhone 17 Pro", 0);
  expect(pressable(buttons)).toEqual([
    ["Action button", "action", "left"],
    ["Volume up", "volumeUp", "left"],
    ["Volume down", "volumeDown", "left"],
    ["Side button", "power", "right"],
  ]);
  const action = named(buttons, "Action button");
  expect(action.start + action.length).toBeLessThan(named(buttons, "Volume up").start);
});

test("iPhones before the 15 Pro have a ring switch there, drawn but not pressable", () => {
  for (const name of ["iPhone 15", "iPhone 14 Pro", "iPhone SE (3rd generation)"]) {
    const buttons = deviceButtons("iphone", name, 0);
    expect(named(buttons, "Ring/Silent switch").key).toBeUndefined();
    expect(buttons.some((button) => button.key === "action")).toBe(false);
  }
  expect(named(deviceButtons("iphone", "iPhone 16e", 0), "Action button").key).toBe("action");
});

test("an iPad's top button is on its top edge by the right corner, its volume buttons on the right", () => {
  const buttons = deviceButtons("ipad", "iPad Pro 13-inch (M4)", 0);
  const top = named(buttons, "Top button");
  expect(top).toMatchObject({ edge: "top", key: "power" });
  expect(top.start).toBeGreaterThan(0.5);
  expect(named(buttons, "Volume up").edge).toBe("right");
  expect(named(buttons, "Volume up").start).toBeLessThan(0.25);
});

test("an Apple Watch's Digital Crown presses Home and sits above its side button", () => {
  const buttons = deviceButtons("watch", "Apple Watch Series 11 (46mm)", 0);
  expect(pressable(buttons)).toEqual([
    ["Digital Crown", "home", "right"],
    ["Side button", "side", "right"],
  ]);
});

test("a TV and Vision Pro have no buttons to draw", () => {
  expect(deviceButtons("tv", "Apple TV 4K", 0)).toEqual([]);
  expect(deviceButtons("vision", "Apple Vision Pro", 90)).toEqual([]);
});

test("an iPhone turned to landscape left carries its left-edge buttons to the top, in reverse", () => {
  const buttons = deviceButtons("iphone", "iPhone 17 Pro", 90);
  const action = named(buttons, "Action button");
  const up = named(buttons, "Volume up");
  const down = named(buttons, "Volume down");
  expect([action.edge, up.edge, down.edge]).toEqual(["top", "top", "top"]);
  // The top of the left edge turns to the right end of the top edge.
  expect(action.start).toBeGreaterThan(up.start);
  expect(up.start).toBeGreaterThan(down.start);
  expect(action.start + action.length).toBeCloseTo(1 - 0.18);
  expect(named(buttons, "Side button").edge).toBe("bottom");
});

test("an Android phone in landscape has its buttons on the top edge, power still nearer the corner", () => {
  const buttons = deviceButtons("android-phone", "Pixel 9", 270);
  const power = named(buttons, "Power button");
  const up = named(buttons, "Volume up");
  expect([power.edge, up.edge]).toEqual(["top", "top"]);
  expect(power.start).toBeLessThan(up.start);
});

test("upside down, an iPhone's volume buttons are on its right edge near the bottom", () => {
  const upright = named(deviceButtons("iphone", "iPhone 17 Pro", 0), "Volume up");
  const flipped = named(deviceButtons("iphone", "iPhone 17 Pro", 180), "Volume up");
  expect(flipped.edge).toBe("right");
  expect(flipped.start).toBeCloseTo(1 - upright.start - upright.length);
  expect(flipped.start).toBeGreaterThan(0.5);
});

test("the body's turn comes from the picture's turn, else from landscape by platform", () => {
  const portrait = { width: 393, height: 852 };
  const landscape = { width: 852, height: 393 };
  expect(bodyTurn("ios", portrait, 0)).toBe(0);
  expect(bodyTurn("ios", portrait, 90)).toBe(90);
  expect(bodyTurn("ios", portrait, 270)).toBe(270);
  // A Simulator window's capture comes upright: ace turns it to landscape left.
  expect(bodyTurn("ios", landscape, 0)).toBe(90);
  // Android's first rotation turns the phone a quarter anticlockwise.
  expect(bodyTurn("android", landscape, 0)).toBe(270);
  expect(bodyTurn("android", portrait, 0)).toBe(0);
});
