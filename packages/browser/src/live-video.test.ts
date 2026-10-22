import { describe, expect, it } from "vitest";
import type { BrowserCdp, VideoHost } from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { LiveVideo } from "./live-video.ts";
import type { VideoEncode } from "./video-policy.ts";

const page: BrowserCdp = { send: async () => ({}), on: () => {}, off: () => {} };

/** An encoder that records the encodes it is asked to run. */
function fakeHost() {
  const encodes: VideoEncode[][] = [];
  const host: VideoHost = {
    supported: async () => ["avc1.42E033"],
    open: async () => ({
      encodes: (specs) => encodes.push([...specs]),
      keyframe: () => {},
      close: () => {},
    }),
  };
  return { host, encodes };
}

/** A Retina pane showing a 659 × 825 responsive page at its own size. */
const retinaPane: CaptureViewer = {
  viewport: { width: 659, height: 825, devicePixelRatio: 2 },
  video: { codecs: ["avc1.42E033"] },
};

async function firstEncode(local: boolean): Promise<VideoEncode | undefined> {
  const encoder = fakeHost();
  const video = new LiveVideo({ now: () => 1_000, playing: () => {} });
  video.attach({ host: encoder.host, page }, "tab-1", { width: 659, height: 825, scale: 2 });
  video.add("viewer", { send: () => true }, retinaPane, undefined, local);
  for (let index = 0; index < 4; index++) {
    video.tick({ width: 659, height: 825 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return encoder.encodes[0]?.[0];
}

describe("the first picture a viewer gets", () => {
  it("a Retina viewer on this machine gets the page at its full device pixels and a rate for sharp text", async () => {
    const encode = await firstEncode(true);
    expect(encode).toMatchObject({ width: 1318, height: 1650 });
    // 1318 × 1650 at 60 fps needs a few Mbit/s for sharp text; a local link carries it.
    expect(encode?.bitrate).toBeGreaterThan(6_000_000);
  });

  it("a viewer elsewhere starts with a smaller picture its unproven link can carry", async () => {
    const encode = await firstEncode(false);
    expect(encode?.width).toBeLessThan(1318);
    expect(encode?.bitrate).toBeLessThanOrEqual(1_500_000);
  });
});
