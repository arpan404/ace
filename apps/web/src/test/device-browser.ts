import { flakyCheckout } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { harness } from "./harness.tsx";

/** One thing the page's drawing and decoding did, in the order it happened. */
export type ScreenEvent = "drew jpeg" | "drew h264" | "decoder opened" | "decoder failed";

/** A decoded image the page owns until it closes it. */
interface Owned {
  closed: boolean;
  close(): void;
}

/**
 * The browser under a device screen, recorded: jsdom has no 2D canvas, `createImageBitmap` or
 * WebCodecs. `webCodecs` decides what the page finds: none (an older browser), a decoder that
 * decodes every chunk, or one that fails on the first chunk as a broken stream would.
 */
export function deviceBrowser(webCodecs: "none" | "decodes" | "fails") {
  const events: ScreenEvent[] = [];
  const drawn: HTMLCanvasElement[] = [];
  const bitmaps: Owned[] = [];
  const videoFrames: Owned[] = [];
  const decoders: { state: "unconfigured" | "configured" | "closed" }[] = [];

  class FakeVideoFrame implements Owned {
    closed = false;
    close() {
      this.closed = true;
    }
  }
  class FakeVideoDecoder {
    static isConfigSupported() {
      return Promise.resolve({ supported: true });
    }
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    decodeQueueSize = 0;
    private readonly init: { output(frame: FakeVideoFrame): void; error(error: Error): void };
    constructor(init: { output(frame: FakeVideoFrame): void; error(error: Error): void }) {
      this.init = init;
      decoders.push(this);
      events.push("decoder opened");
    }
    configure() {
      this.state = "configured";
    }
    decode() {
      if (this.state !== "configured")
        throw new DOMException("Not configured", "InvalidStateError");
      // A decoder's output arrives after decode() returns.
      queueMicrotask(() => {
        if (this.state !== "configured") return;
        if (webCodecs === "fails") {
          // A failed decoder closes itself before reporting, as WebCodecs specifies.
          this.state = "closed";
          events.push("decoder failed");
          this.init.error(new DOMException("Unsupported stream", "EncodingError"));
          return;
        }
        const frame = new FakeVideoFrame();
        videoFrames.push(frame);
        this.init.output(frame);
      });
    }
    close() {
      this.state = "closed";
    }
  }

  vi.stubGlobal("createImageBitmap", (blob: Blob) => {
    const bitmap: Owned = {
      closed: false,
      close() {
        bitmap.closed = true;
      },
    };
    if (blob.type === "image/jpeg") bitmaps.push(bitmap);
    return Promise.resolve(bitmap);
  });
  if (webCodecs !== "none") {
    vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal(
      "EncodedVideoChunk",
      class {
        readonly init: unknown;
        constructor(init: unknown) {
          this.init = init;
        }
      },
    );
  }
  const context = (canvas: HTMLCanvasElement) => ({
    drawImage(image: Owned) {
      // Drawing a closed image would show nothing: only open images count as drawn.
      if (image.closed) return;
      drawn.push(canvas);
      events.push(image instanceof FakeVideoFrame ? "drew h264" : "drew jpeg");
    },
  });
  const restore = [
    swap(HTMLCanvasElement.prototype, "getContext", function (this: HTMLCanvasElement) {
      return context(this);
    }),
    // The screen is laid out at the device's own size, so a client point is a device point.
    swap(HTMLCanvasElement.prototype, "getBoundingClientRect", () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 390,
      bottom: 844,
      width: 390,
      height: 844,
      toJSON: () => ({}),
    })),
    swap(Element.prototype, "setPointerCapture", () => {}),
    swap(Element.prototype, "releasePointerCapture", () => {}),
    swap(Element.prototype, "hasPointerCapture", () => false),
  ];
  return {
    events,
    /** How many images were drawn on `canvas`. */
    draws: (canvas: Element) => drawn.filter((target) => target === canvas).length,
    bitmaps,
    videoFrames,
    decoders,
    restore() {
      for (const undo of restore) undo();
      vi.unstubAllGlobals();
    },
  };
}

/** Replace a property for one test; the returned function puts the original back. */
function swap(target: object, key: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return () => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  };
}

/** The checkout thread with its Devices tool open in the side panel. */
export async function openDevices() {
  // Control leases expire on the daemon's clock; here it is the page's.
  const app = harness({ clock: () => Date.now() });
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  await app.open("/t/thread-checkout");
  // ⌃⇧M opens the Devices tool in the side panel.
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Devices", selected: true })).toBeTruthy();
  return { app, panel };
}

/** Open a device from the catalog as its own tab; its region once loaded. */
export async function openDevice(panel: HTMLElement, name: string) {
  const list = await within(panel).findByRole("list", { name: "Devices" });
  await userEvent.click(within(list).getByRole("button", { name: new RegExp(`^${name}`) }));
  return within(panel).findByRole("region", { name });
}
