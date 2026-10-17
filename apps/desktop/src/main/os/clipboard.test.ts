import { expect, test } from "vitest";
import { requestChannel } from "../../shared/channels.ts";
import { clipboardImageLimit } from "../../shared/contract.ts";
import { createBridge, BridgeError, type BridgeIpc } from "../../preload/bridge.ts";
import { writeClipboardImage } from "./clipboard.ts";

const info = {
  version: "0.1.0",
  platform: "darwin",
  arch: "arm64",
  electron: "44.5.1",
  packaged: false,
} as const;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

function main() {
  const sent: { channel: string; payload: unknown }[] = [];
  const ipc: BridgeIpc = {
    async invoke(channel, payload) {
      sent.push({ channel, payload });
      return undefined;
    },
    on: () => () => {},
  };
  return { ace: createBridge(ipc, info), sent };
}

/** A clipboard that decodes only real PNG headers, as Electron's nativeImage does. */
function clipboard() {
  const written: Buffer[] = [];
  return {
    written,
    native: {
      decode: (bytes: Buffer) => ({
        isEmpty: () => bytes.subarray(1, 4).toString() !== "PNG",
        toPNG: () => bytes,
      }),
      writePng: async (bytes: Buffer) => void written.push(bytes),
    },
  };
}

test("an annotated page's screenshot crosses to the clipboard as PNG or JPEG bytes", async () => {
  const { ace, sent } = main();
  await ace.clipboard.writeImage({ mimeType: "image/png", data: png });
  expect(sent).toEqual([
    {
      channel: requestChannel("clipboard.writeImage"),
      payload: { mimeType: "image/png", data: png },
    },
  ]);
  const target = clipboard();
  await writeClipboardImage({ mimeType: "image/png", data: png }, target.native);
  expect(target.written[0]?.subarray(1, 4).toString()).toBe("PNG");
});

test("the bridge never sends an oversized, non-image or malformed clipboard write", async () => {
  const { ace, sent } = main();
  const over = "A".repeat(Math.ceil(clipboardImageLimit / 3) * 4 + 4);
  await expect(
    ace.clipboard.writeImage({ mimeType: "image/png", data: over }),
  ).rejects.toBeInstanceOf(BridgeError);
  await expect(
    // @ts-expect-error: only PNG and JPEG are accepted.
    ace.clipboard.writeImage({ mimeType: "image/svg+xml", data: png }),
  ).rejects.toBeInstanceOf(BridgeError);
  await expect(
    ace.clipboard.writeImage({ mimeType: "image/png", data: "not base64!" }),
  ).rejects.toBeInstanceOf(BridgeError);
  expect(sent).toEqual([]);
});

test("bytes that aren't an image leave the clipboard as it was", async () => {
  const target = clipboard();
  await expect(
    writeClipboardImage({ mimeType: "image/png", data: btoa("plain text") }, target.native),
  ).rejects.toThrow("The image couldn't be read");
  expect(target.written).toEqual([]);
});
