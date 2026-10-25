import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function skin(name: string, layout = pixelLayout) {
  const directory = join(root, "sdk/skins", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "layout"), layout);
  writeFileSync(join(directory, "back.webp"), Buffer.from("RIFFback"));
  writeFileSync(join(directory, "mask.webp"), Buffer.from("RIFFmask"));
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

test("an emulator wears the skin its hardware profile names, with the display where the layout puts it", async () => {
  skin("pixel_7");
  avd("Pixel_7_API_36", "hw.device.name = pixel_7\nhw.lcd.width = 1080\nskin.dynamic=yes\n");

  const chrome = await readAndroidSkin(source(), "Pixel_7_API_36");

  expect(chrome?.body).toMatchObject({ width: 1200, height: 2541 });
  expect(chrome?.body.image).toBe(`data:image/webp;base64,${btoa("RIFFback")}`);
  expect(chrome?.screen).toEqual({ x: 59, y: 58, width: 1080, height: 2400 });
  expect(chrome?.mask).toBe(`data:image/webp;base64,${btoa("RIFFmask")}`);
  expect(chrome?.buttons).toEqual([]);
});

test("an AVD with no skin, or one the SDK doesn't have, keeps the drawn frame", async () => {
  avd("Plain", "skin.name=_no_skin\nskin.path=_no_skin\n");
  avd("Gone", "hw.device.name = pixel_99\n");
  expect(await readAndroidSkin(source(), "Plain")).toBeUndefined();
  expect(await readAndroidSkin(source(), "Gone")).toBeUndefined();
  expect(await readAndroidSkin(source(), "Never_Made")).toBeUndefined();
});

test("a skin whose portrait display is turned isn't drawn, since its picture wouldn't line up", async () => {
  skin("odd", pixelLayout.replace("y 58\n", "y 58\n      rotation 1\n"));
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
