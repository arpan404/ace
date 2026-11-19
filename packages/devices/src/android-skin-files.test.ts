import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSmallFile } from "./device-chrome-sources.ts";
import { readAndroidSkin, type AndroidSkinSource } from "./android-skin-files.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ace-skin-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A skin laid out as the Android SDK ships one: a portrait picture, a mask and the display. */
const pixelLayout = `parts {
  device {
    display {
      width 1080
      height 2400
      x 0
      y 0
    }
  }
  portrait {
    background {
      image back.webp
    }
    foreground {
      mask mask.webp
      cutout hole
    }
  }
}
layouts {
  portrait {
    width 1200
    height 2541
    event EV_SW:0:1
    part1 {
      name portrait
      x 0
      y 0
    }
    part2 {
      name device
      x 59
      y 58
    }
  }
}
`;

/**
 * A WebP of `width` × `height`: opaque, with a clear rounded rectangle cut from it at `hole`.
 * A skin's picture has the screen's opening cut from its glass; its mask is opaque only over
 * the display's rounded corners.
 */
async function cutOut(
  width: number,
  height: number,
  hole: { x: number; y: number; width: number; height: number; radius: number },
) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><mask id="m"><rect width="${width}" height="${height}" fill="#fff"/><rect x="${hole.x}" y="${hole.y}" width="${hole.width}" height="${hole.height}" rx="${hole.radius}" fill="#000"/></mask></defs><rect width="${width}" height="${height}" fill="#141414" mask="url(#m)"/></svg>`;
  return sharp(Buffer.from(svg)).webp({ lossless: true }).toBuffer();
}

async function skin(name: string, layout = pixelLayout, maskRadius: number | undefined = 54) {
  const directory = join(root, "sdk/skins", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "layout"), layout);
  writeFileSync(
    join(directory, "back.webp"),
    await cutOut(1200, 2541, { x: 59, y: 58, width: 1080, height: 2400, radius: 90 }),
  );
  if (maskRadius !== undefined)
    writeFileSync(
      join(directory, "mask.webp"),
      await cutOut(1080, 2400, { x: 0, y: 0, width: 1080, height: 2400, radius: maskRadius }),
    );
}

function avd(name: string, config: string) {
  const directory = join(root, "avd", `${name}.avd`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "avd", `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${directory}\n`);
  writeFileSync(join(directory, "config.ini"), config);
}

const source = (): AndroidSkinSource => ({
  avdRoots: [join(root, "avd")],
  sdkRoots: [join(root, "sdk")],
  readFile: readSmallFile,
});

test("an emulator wears one thin, even bezel around its display, rounded as the skin's screen is", async () => {
  await skin("pixel_7");
  avd("Pixel_7_API_36", "hw.device.name = pixel_7\nhw.lcd.width = 1080\nskin.dynamic=yes\n");

  const chrome = await readAndroidSkin(source(), "Pixel_7_API_36");

  // The display keeps its size; the body hugs it with the same bezel on every side, not the
  // skin picture's uneven 59 / 58 / 83 margins.
  const screen = chrome?.screen;
  expect(screen).toMatchObject({ width: 1080, height: 2400 });
  expect(screen?.x).toBe(screen?.y);
  expect(chrome?.body.width).toBe(1080 + 2 * (screen?.x ?? 0));
  expect(chrome?.body.height).toBe(2400 + 2 * (screen?.y ?? 0));
  expect(screen?.x).toBeLessThan(40);
  expect(chrome?.body.image).toMatch(/^data:image\/svg\+xml;base64,/);
  // The picture is clipped to the corners the skin's mask draws (radius 54).
  const mask = Buffer.from(chrome?.mask?.split(",")[1] ?? "", "base64").toString("utf8");
  expect(Number(/rx="([\d.]+)"/.exec(mask)?.[1])).toBeCloseTo(54, -1);
  // The skin's corners and camera hole are still drawn over the whole display.
  expect(chrome?.cutout?.rect).toEqual(screen);
  expect(chrome?.cutout?.image).toMatch(/^data:image\/webp;base64,/);
  expect(chrome?.buttons).toEqual([]);
});

test("a skin with no mask takes its screen's roundness from the opening in its picture", async () => {
  await skin("bare", pixelLayout.replace("      mask mask.webp\n", ""), undefined);
  avd("Bare", "hw.device.name = bare\n");

  const chrome = await readAndroidSkin(source(), "Bare");

  const mask = Buffer.from(chrome?.mask?.split(",")[1] ?? "", "base64").toString("utf8");
  expect(Number(/rx="([\d.]+)"/.exec(mask)?.[1])).toBeCloseTo(90, -1);
  expect(chrome?.cutout).toBeUndefined();
});

test("an AVD with no skin, or one the SDK doesn't have, keeps the drawn frame", async () => {
  avd("Plain", "skin.name=_no_skin\nskin.path=_no_skin\n");
  avd("Gone", "hw.device.name = pixel_99\n");
  expect(await readAndroidSkin(source(), "Plain")).toBeUndefined();
  expect(await readAndroidSkin(source(), "Gone")).toBeUndefined();
  expect(await readAndroidSkin(source(), "Never_Made")).toBeUndefined();
});

test("a skin whose portrait display is turned isn't drawn, since its picture wouldn't line up", async () => {
  await skin("odd", pixelLayout.replace("y 58\n", "y 58\n      rotation 1\n"));
  avd("Odd", "hw.device.name = odd\n");
  expect(await readAndroidSkin(source(), "Odd")).toBeUndefined();
});

test("an AVD naming a skin outside the SDK by a relative path is never followed there", async () => {
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  writeFileSync(join(root, "elsewhere/layout"), pixelLayout);
  writeFileSync(join(root, "elsewhere/back.webp"), Buffer.from("RIFFback"));
  avd("Sneaky", "skin.path=../elsewhere\n");
  expect(await readAndroidSkin(source(), "Sneaky")).toBeUndefined();
});

test("a tablet skin whose only layout is landscape is read at its natural way up", async () => {
  await skin(
    "pixel_tablet",
    pixelLayout
      .replace("width 1080\n      height 2400", "width 2560\n      height 1600")
      .replace(
        "  portrait {\n    width 1200\n    height 2541",
        "  landscape {\n    width 2798\n    height 1837",
      )
      .replace("x 59\n      y 58", "x 119\n      y 117"),
  );
  avd("Tablet", "hw.device.name=pixel_tablet\n");
  const chrome = await readAndroidSkin(source(), "Tablet");
  const screen = chrome?.screen;
  expect(screen).toMatchObject({ width: 2560, height: 1600 });
  expect(chrome?.body.width).toBeGreaterThan(chrome?.body.height ?? Infinity);
});
