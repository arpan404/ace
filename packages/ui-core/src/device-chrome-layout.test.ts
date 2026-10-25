import { expect, test } from "vitest";
import type { DeviceChrome } from "@ace/protocol";
import {
  chromeButtonEdge,
  chromeButtonKey,
  chromeButtonLabel,
  chromeLayout,
  turnedImage,
} from "./device-chrome-layout.ts";

const image = "data:image/svg+xml;base64,PHN2Zy8+";
/** An iPhone 17 Pro's chrome: a 402 × 874 point screen 17 points inside a 436 × 908 body. */
const phone: DeviceChrome = {
  body: { width: 436, height: 908, image },
  screen: { x: 17, y: 17, width: 402, height: 874 },
  buttons: [
    { name: "power", rect: { x: 428, y: 262, width: 16, height: 101 }, image, onTop: false },
  ],
};
const upright = { width: 402, height: 874 };

test("the body fits the room with the screen where the chrome puts it", () => {
  const layout = chromeLayout(phone, 0, upright, { width: 400, height: 800 });
  const scale = 800 / 908;
  expect(layout?.box.height).toBeCloseTo(800);
  expect(layout?.screen.left).toBeCloseTo(17 * scale);
  expect(layout?.screen.width).toBeCloseTo(402 * scale);
});

test("a body is never drawn larger than one pixel per point of its screen", () => {
  const layout = chromeLayout(phone, 0, upright, { width: 4000, height: 4000 });
  expect(layout?.screen.width).toBeCloseTo(402);
  expect(layout?.box.width).toBeCloseTo(436);
});

test("turned a quarter clockwise, the box lies on its side and the screen follows the body", () => {
  const sideways = { width: 874, height: 402 };
  const layout = chromeLayout(phone, 90, sideways, { width: 908, height: 436 });
  expect(layout?.box.width).toBeCloseTo(908);
  expect(layout?.box.height).toBeCloseTo(436);
  // The body's top (17 points above the screen) is now on the right.
  expect(layout?.screen).toMatchObject({ top: 17, width: 874, height: 402 });
  expect(layout?.screen.left).toBeCloseTo(908 - 17 - 874);
  // The upright plate is centred in the box, to be turned about its middle.
  expect(layout?.plate.left).toBeCloseTo((908 - 436) / 2);
});

test("a picture that isn't the chrome's screen shape gets no chrome", () => {
  expect(chromeLayout(phone, 0, { width: 400, height: 600 }, { width: 500, height: 900 })).toBe(
    undefined,
  );
});

test("a skin a little taller than its emulator's display is stretched to fit the picture", () => {
  const skin: DeviceChrome = {
    body: { width: 1200, height: 2541, image },
    screen: { x: 59, y: 58, width: 1080, height: 2400 },
    buttons: [],
  };
  // The AVD's display is 1080 × 2340: 2.5% shorter than the skin's.
  const layout = chromeLayout(
    skin,
    0,
    { width: 1080, height: 2340 },
    { width: 2000, height: 3000 },
  );
  expect(layout).toBeDefined();
  expect((layout?.screen.height ?? 0) / (layout?.screen.width ?? 1)).toBeCloseTo(2340 / 1080);
});

test("each chrome button presses the key the hardware does, and a ring switch presses nothing", () => {
  expect(chromeButtonKey({ name: "action" })).toBe("action");
  expect(chromeButtonKey({ name: "volume-up" })).toBe("volumeUp");
  expect(chromeButtonKey({ name: "power" })).toBe("power");
  expect(chromeButtonKey({ name: "digital-crown" })).toBe("home");
  expect(chromeButtonKey({ name: "mute" })).toBeUndefined();
  expect(chromeButtonKey({ name: "toString" })).toBeUndefined();
});

test("the power button is the side button on a phone and the top button on an iPad", () => {
  expect(chromeButtonLabel({ name: "power" }, "iphone")).toBe("Side button");
  expect(chromeButtonLabel({ name: "power" }, "ipad")).toBe("Top button");
  expect(chromeButtonLabel({ name: "left-side-button", title: "Action" }, "watch")).toBe("Action");
});

test("a button's tooltip opens on the side it stands out from once the body is turned", () => {
  const power = phone.buttons[0];
  if (!power) throw new Error("no button");
  expect(chromeButtonEdge(power, phone.body, 0)).toBe("right");
  expect(chromeButtonEdge(power, phone.body, 90)).toBe("bottom");
  expect(chromeButtonEdge(power, phone.body, 270)).toBe("top");
});

test("an upright mask is used as it is, and a turned one is wrapped turned", () => {
  expect(turnedImage(image, { width: 402, height: 874 }, 0)).toBe(image);
  const turned = decodeURIComponent(turnedImage(image, { width: 402, height: 874 }, 90));
  expect(turned).toContain('viewBox="0 0 874 402"');
  expect(turned).toContain("rotate(90)");
});
