import { describe, expect, it } from "vitest";
import type { BrowserCdp, CaptureEvents, VideoHost } from "./backend.ts";
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

/** An encoder whose captures open, and which the test ends or feeds by hand. */
function endingHost() {
  const opened: CaptureEvents[] = [];
  const host: VideoHost = {
    supported: async () => ["avc1.42E033"],
    open: async (_page, _width, _height, events) => {
      opened.push(events);
      return { encodes: () => {}, keyframe: () => {}, close: () => {} };
    },
  };
  return { host, opened };
}

/** A viewer watching tab-1, on a clock the test moves, counting status changes. */
async function watched() {
  let clock = 1_000;
  let changes = 0;
  const encoder = endingHost();
  const video = new LiveVideo({
    now: () => clock,
    playing: () => {},
    statusChanged: () => void changes++,
  });
  video.attach({ host: encoder.host, page }, "tab-1", { width: 800, height: 600, scale: 1 });
  video.add("viewer", { send: () => true }, retinaPane);
  /** Ticks the video every 50 ms for `milliseconds`, letting each open settle. */
  const run = async (milliseconds: number) => {
    for (const until = clock + milliseconds; clock < until; clock += 50) {
      video.tick({ width: 800, height: 600 });
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    }
  };
  return { video, encoder, run, changes: () => changes, now: () => clock };
}

describe("a tab whose capture keeps ending before its first picture", () => {
  const noPicture = "The tab capture sent no picture";

  it("tries again later each time, longer every time, and says it is retrying", async () => {
    const t = await watched();
    await t.run(200);
    expect(t.encoder.opened.length).toBe(1);
    expect(t.video.status()).toBeUndefined();
    const waits: number[] = [];
    for (let failure = 1; failure <= 4; failure++) {
      const opens = t.encoder.opened.length;
      t.encoder.opened.at(-1)?.ended(noPicture);
      expect(t.video.status()).toEqual({
        status: "retrying",
        reason: noPicture,
        attempts: failure,
      });
      const endedAt = t.now();
      while (t.encoder.opened.length === opens) await t.run(50);
      waits.push(t.now() - endedAt);
    }
    // Each wait is about double the one before it (on the 50 ms tick).
    for (let index = 1; index < waits.length; index++)
      expect(waits[index]).toBeGreaterThan(1.8 * (waits[index - 1] ?? 0));
    expect(t.changes()).toBe(4);
  });

  it("stops growing its wait at a minute", async () => {
    const t = await watched();
    await t.run(200);
    for (let failure = 1; failure <= 8; failure++) {
      const opens = t.encoder.opened.length;
      t.encoder.opened.at(-1)?.ended(noPicture);
      const endedAt = t.now();
      while (t.encoder.opened.length === opens) await t.run(1_000);
      expect(t.now() - endedAt).toBeLessThanOrEqual(61_000);
    }
  });

  it("is playing again once a capture gives video, and the next failure starts over", async () => {
    const t = await watched();
    await t.run(200);
    t.encoder.opened.at(-1)?.ended(noPicture);
    let opens = t.encoder.opened.length;
    while (t.encoder.opened.length === opens) await t.run(50);
    t.encoder.opened.at(-1)?.ended(noPicture);
    expect(t.video.status()?.attempts).toBe(2);
    opens = t.encoder.opened.length;
    while (t.encoder.opened.length === opens) await t.run(50);
    t.encoder.opened.at(-1)?.chunk({
      encode: "avc1.42E033/1318x1650/60",
      key: true,
      codec: "avc1.42E033",
      codedWidth: 1318,
      codedHeight: 1650,
      bytes: new Uint8Array(8),
    });
    expect(t.video.status()).toBeUndefined();
    expect(t.changes()).toBe(3);
    // A capture that played and then ended is no failure: it reopens on the next tick.
    opens = t.encoder.opened.length;
    t.encoder.opened.at(-1)?.ended();
    await t.run(100);
    expect(t.encoder.opened.length).toBe(opens + 1);
    expect(t.video.status()).toBeUndefined();
    // A failure after that waits the first, shortest time again.
    t.encoder.opened.at(-1)?.ended(noPicture);
    expect(t.video.status()?.attempts).toBe(1);
  });

  it("starts afresh, without waiting, when the person shows another tab", async () => {
    const t = await watched();
    await t.run(200);
    t.encoder.opened.at(-1)?.ended(noPicture);
    expect(t.video.status()?.attempts).toBe(1);
    const opens = t.encoder.opened.length;
    t.video.attach({ host: t.encoder.host, page }, "tab-2", { width: 800, height: 600, scale: 1 });
    expect(t.video.status()).toBeUndefined();
    await t.run(100);
    expect(t.encoder.opened.length).toBe(opens + 1);
  });
});
