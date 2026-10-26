import type { DeviceChrome } from "@ace/protocol";
import { expect, test } from "vitest";
import { phoneChrome } from "./phone-chrome.ts";

const png = "data:image/png;base64,iVBORw0KGgo=";
/** An iPhone 17 Pro's look: a 402 × 874 point screen 17 points inside a 436 × 908 body. */
const iphone: DeviceChrome = {
  body: { width: 436, height: 908, image: png },
  screen: { x: 17, y: 17, width: 402, height: 874 },
  mask: png,
  buttons: [
    { name: "power", rect: { x: 428, y: 262, width: 16, height: 101 }, image: png, onTop: false },
    { name: "mute", rect: { x: -8, y: 160, width: 16, height: 34 }, image: png, onTop: false },
  ],
};

test("the phone gets the web's layout for each turn, in points", () => {
  const shaped = phoneChrome(iphone, "iphone", { width: 402, height: 874 });
  const [upright, quarter] = shaped?.turns ?? [];
  expect(upright?.box).toEqual({ width: 436, height: 908 });
  expect(upright?.screen).toEqual({ left: 17, top: 17, width: 402, height: 874 });
  // Turned a quarter clockwise, the box lies on its side and the screen follows the body.
  expect(quarter?.box).toEqual({ width: 908, height: 436 });
  expect(quarter?.screen).toMatchObject({ top: 17, width: 874, height: 402 });
  expect(shaped?.turns).toHaveLength(4);
});

test("buttons say what they press and where they sit on the body", () => {
  const shaped = phoneChrome(iphone, "iphone", { width: 402, height: 874 });
  expect(shaped?.buttons.map(({ label, key }) => ({ label, key }))).toEqual([
    { label: "Side button", key: "power" },
    // Drawn, but ace can't press it.
    { label: "Ring/Silent switch", key: "" },
  ]);
  expect(shaped?.buttons[0]?.rect.x).toBeCloseTo(428 / 436);
});

test("an emulator skin in pixels comes out in the device's points", () => {
  const skin: DeviceChrome = {
    body: { width: 1200, height: 2541, image: png },
    screen: { x: 59, y: 58, width: 1080, height: 2400 },
    buttons: [],
  };
  const shaped = phoneChrome(skin, "android-phone", { width: 412, height: 915 });
  expect(shaped?.turns[0]?.screen.width).toBeCloseTo(412);
  expect(shaped?.turns[0]?.box.width).toBeCloseTo((1200 * 412) / 1080);
  expect(shaped?.mask).toBeNull();
});
