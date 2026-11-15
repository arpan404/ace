import { afterEach, describe, expect, it } from "vitest";
import { drawPoster } from "./poster.ts";
import type { DecodedPicture } from "./codecs.ts";

const poster = { width: 4, height: 2, jpeg: "/9j/AA==" };
const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
afterEach(() => {
  if (original) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", original);
});

/** A canvas whose 2D context records what was drawn on it. */
function canvas() {
  const fake = { save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {} };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => fake,
  });
  const element = document.createElement("canvas");
  const context = element.getContext("2d");
  if (!context) throw new Error("no 2D context");
  return { element, context };
}

/** A poster decode the test finishes, remembering whether its image was drawn or closed. */
function decoding() {
  const image = { drawn: false, closed: false };
  let finish: ((picture: DecodedPicture) => void) | undefined;
  const decode = () => new Promise<DecodedPicture>((resolve) => (finish = resolve));
  const done = () =>
    finish?.({
      sequence: -1,
      draw: () => void (image.drawn = true),
      close: () => void (image.closed = true),
    });
  return { decode, done, image };
}

describe("a live view's poster", () => {
  it("is drawn when its delivery is still the view's once decoded", async () => {
    const { element, context } = canvas();
    const { decode, done, image } = decoding();
    const drawing = drawPoster(element, context, poster, () => true, decode);
    done();
    expect(await drawing).toBe(true);
    expect(image.drawn).toBe(true);
  });

  it("decoded after its source rebound or its view went, is closed and never drawn", async () => {
    const { element, context } = canvas();
    const { decode, done, image } = decoding();
    let current = true;
    const drawing = drawPoster(element, context, poster, () => current, decode);
    current = false;
    done();
    expect(await drawing).toBe(false);
    expect(image.drawn).toBe(false);
    expect(image.closed).toBe(true);
  });
});
