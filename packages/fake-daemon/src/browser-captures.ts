import type { BrowserScreenshotSet, BrowserScreenshotSize } from "@ace/protocol";

const widths: Record<BrowserScreenshotSize, [number, number]> = {
  phone: [390, 844],
  tablet: [768, 1024],
  desktop: [1440, 900],
};
/** The smallest JPEG there is: the fixture's captures carry no real picture. */
const blank =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/** A multi-size screenshot as the daemon answers a person: a kept PNG and a preview per size. */
export function fakeScreenshotSet(
  threadId: string,
  sizes: readonly BrowserScreenshotSize[],
): BrowserScreenshotSet {
  return {
    images: sizes.map((size) => {
      const [width, height] = widths[size];
      return {
        size,
        width,
        height,
        mimeType: "image/jpeg",
        data: blank,
        path: `/fake/browser/${threadId}/screenshot-${size}.png`,
      };
    }),
  };
}
