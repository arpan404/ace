import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { copyImageToClipboard } from "./clipboard-image.ts";

/*
 * Copying an image to the clipboard: the browser gets a PNG ClipboardItem created
 * synchronously in the click (keeping its activation while the bytes arrive); the desktop
 * app writes through its native bridge instead. Only what the platform lacks is stubbed.
 */

const pngBytes = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

/** The platform's ClipboardItem, recording what the page hands the clipboard. */
class ClipboardItemStub {
  readonly types: string[];
  private readonly data: Record<string, Blob | Promise<Blob>>;
  constructor(data: Record<string, Blob | Promise<Blob>>) {
    this.data = data;
    this.types = Object.keys(data);
  }
  async getType(type: string): Promise<Blob> {
    const value = this.data[type];
    if (!value) throw new Error(`missing ${type}`);
    return value;
  }
}

const clipboardWrite = vi.fn();
const originalClipboard = Reflect.get(navigator, "clipboard");

beforeEach(() => {
  clipboardWrite.mockReset();
  vi.stubGlobal("ClipboardItem", ClipboardItemStub);
  Object.defineProperty(navigator, "clipboard", {
    value: { write: clipboardWrite },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", { value: originalClipboard });
});

const png = () => new Blob([pngBytes.slice()], { type: "image/png" });

test("a PNG reaches the browser clipboard as image/png bytes", async () => {
  clipboardWrite.mockResolvedValueOnce(undefined);
  await copyImageToClipboard(Promise.resolve(png()), {});
  expect(clipboardWrite).toHaveBeenCalledTimes(1);
  const [items] = clipboardWrite.mock.calls[0] as [ClipboardItemStub[]];
  const [item] = items;
  expect(item?.types).toEqual(["image/png"]);
  const written = await item?.getType("image/png");
  expect(written?.type).toBe("image/png");
  expect(written && new Uint8Array(await written.arrayBuffer())).toEqual(pngBytes);
});

test("the ClipboardItem is created synchronously within the click's activation", () => {
  clipboardWrite.mockReturnValueOnce(new Promise(() => {}));
  let constructed: ClipboardItemStub[] | undefined;
  vi.stubGlobal(
    "ClipboardItem",
    class extends ClipboardItemStub {
      constructor(data: Record<string, Blob | Promise<Blob>>) {
        super(data);
        constructed = [this];
      }
    },
  );
  const pending = copyImageToClipboard(Promise.resolve(png()), {});
  // Still the same task as the click: no await has run yet.
  expect(constructed).toHaveLength(1);
  expect(clipboardWrite).toHaveBeenCalledTimes(1);
  void pending.catch(() => {});
});

test("the desktop app writes through its native bridge instead of the page clipboard", async () => {
  const writeImage = vi.fn(
    async (_image: { mimeType: string; data: string }): Promise<void> => undefined,
  );
  await copyImageToClipboard(Promise.resolve(png()), {
    ace: { clipboard: { writeImage } },
  });
  expect(clipboardWrite).not.toHaveBeenCalled();
  expect(writeImage).toHaveBeenCalledTimes(1);
  const [image] = writeImage.mock.calls[0] ?? [];
  expect(image?.mimeType).toBe("image/png");
  expect(image && Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))).toEqual(
    pngBytes,
  );
});

test("a JPEG keeps its bytes through the desktop bridge", async () => {
  const writeImage = vi.fn(
    async (_image: { mimeType: string; data: string }): Promise<void> => undefined,
  );
  const jpeg = new Blob([pngBytes.slice()], { type: "image/jpeg" });
  await copyImageToClipboard(Promise.resolve(jpeg), {
    ace: { clipboard: { writeImage } },
  });
  const [image] = writeImage.mock.calls[0] ?? [];
  expect(image?.mimeType).toBe("image/jpeg");
});

test("a bridge refusal rejects so the lightbox can show its failure toast", async () => {
  await expect(
    copyImageToClipboard(Promise.resolve(png()), {
      ace: {
        clipboard: {
          writeImage: async () => {
            throw new Error("denied");
          },
        },
      },
    }),
  ).rejects.toThrow("denied");
});
