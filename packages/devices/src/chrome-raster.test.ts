import sharp from "sharp";
import { expect, test } from "vitest";
import type { DeviceChrome } from "@ace/protocol/devices";
import { chromeAsPng } from "./chrome-raster.ts";
import { svgPng } from "./device-chrome-sources.ts";

const svg = (width: number, height: number, fill: string) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`,
  ).toString("base64")}`;
const pixels = (url: string | undefined) =>
  sharp(Buffer.from(url?.split(",")[1] ?? "", "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });

test("a native app's look is the same look drawn as PNG at three pixels per point", async () => {
  const chrome: DeviceChrome = {
    body: { width: 100, height: 200, image: svg(100, 200, "#ff0000") },
    screen: { x: 10, y: 10, width: 80, height: 180 },
    mask: svg(80, 180, "#000"),
    buttons: [
      {
        name: "power",
        rect: { x: 96, y: 40, width: 8, height: 30 },
        image: svg(8, 30, "#00ff00"),
        onTop: false,
      },
    ],
  };
  const png = await chromeAsPng(chrome, svgPng);

  expect(png?.body.image).toMatch(/^data:image\/png;base64,/);
  const body = await pixels(png?.body.image);
  expect([body.info.width, body.info.height]).toEqual([300, 600]);
  expect([...body.data.subarray(0, 3)]).toEqual([255, 0, 0]);
  expect(png?.mask).toMatch(/^data:image\/png;base64,/);
  expect(png?.buttons[0]?.image).toMatch(/^data:image\/png;base64,/);
  // Where things are doesn't change with the format.
  expect(png?.screen).toEqual(chrome.screen);
  expect(png?.buttons[0]?.rect).toEqual(chrome.buttons[0]?.rect);
});

test("an emulator skin's WebP is sent as it is, and a button that can't be drawn is left out", async () => {
  const webp = "data:image/webp;base64,UklGRg==";
  const chrome: DeviceChrome = {
    body: { width: 1200, height: 2541, image: webp },
    screen: { x: 59, y: 58, width: 1080, height: 2400 },
    buttons: [
      {
        name: "power",
        rect: { x: 0, y: 0, width: 8, height: 30 },
        image: `data:image/svg+xml;base64,${Buffer.from("not svg").toString("base64")}`,
        onTop: false,
      },
    ],
  };
  const png = await chromeAsPng(chrome, svgPng);
  expect(png?.body.image).toBe(webp);
  expect(png?.buttons).toEqual([]);
});
