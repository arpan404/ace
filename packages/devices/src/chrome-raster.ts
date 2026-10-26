import type { DeviceChrome, DeviceChromeImage } from "@ace/protocol/devices";

/*
 * A look's SVG images as PNG, for clients that can't draw SVG (the native apps). Pure: how one
 * SVG becomes PNG bytes is passed in. Images that aren't SVG (an emulator skin's WebP) stay.
 */

/** Renders one SVG document as PNG bytes, or undefined when it can't. */
export type SvgToPng = (svg: Buffer) => Promise<Buffer | undefined>;

const svgPrefix = "data:image/svg+xml;base64,";

async function png(image: DeviceChromeImage, render: SvgToPng): Promise<string | undefined> {
  if (!image.startsWith(svgPrefix)) return image;
  const bytes = await render(Buffer.from(image.slice(svgPrefix.length), "base64"));
  return bytes ? `data:image/png;base64,${bytes.toString("base64")}` : undefined;
}

/**
 * The same look with every SVG image drawn as PNG. Undefined when the body can't be drawn; a
 * mask, notch or button that can't is left out, as when the SDK lacks it.
 */
export async function chromeAsPng(
  chrome: DeviceChrome,
  render: SvgToPng,
): Promise<DeviceChrome | undefined> {
  const [body, mask, cutout, buttons] = await Promise.all([
    png(chrome.body.image, render),
    chrome.mask ? png(chrome.mask, render) : undefined,
    chrome.cutout ? png(chrome.cutout.image, render) : undefined,
    Promise.all(
      chrome.buttons.map(async ({ pressed, ...button }) => {
        const [image, down] = await Promise.all([
          png(button.image, render),
          pressed ? png(pressed, render) : undefined,
        ]);
        return image ? [{ ...button, image, ...(down ? { pressed: down } : {}) }] : [];
      }),
    ),
  ]);
  if (!body) return undefined;
  return {
    body: { ...chrome.body, image: body },
    screen: chrome.screen,
    ...(mask ? { mask } : {}),
    ...(chrome.cutout && cutout ? { cutout: { rect: chrome.cutout.rect, image: cutout } } : {}),
    buttons: buttons.flat(),
  };
}
