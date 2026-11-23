import { describe, expect, it } from "vitest";
import type { BrowserCdp, CaptureEvents, VideoEncode, VideoHost } from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { encoderRecovering, failedCodecRetryMs, LiveVideo } from "./live-video.ts";

const page: BrowserCdp = { send: async () => ({}), on: () => {}, off: () => {} };
const hevc = "hvc1.1.6.L153.B0";

/** An encoder that records what each capture is told, and lets the test drive its events. */
function fakeHost(supported = ["avc1.42E033"]) {
  const opened: CaptureEvents[] = [];
  const encodes: VideoEncode[][] = [];
  const codecs: string[][] = [];
  const sound: boolean[] = [];
  const pages: { width: number; height: number; scale: number }[] = [];
  let closed = 0;
  const host: VideoHost = {
    mediaKind: "tab",
    supported: async (asked) => asked.filter((codec) => supported.includes(codec)),
    open: async (_page, _width, _height, events) => {
      opened.push(events);
      return {
        encodes: (specs) => encodes.push([...specs]),
        keyframe: () => {},
        codecs: (runs) => codecs.push([...runs]),
        audio: (on) => sound.push(on),
        page: (shown) => pages.push({ ...shown }),
        close: () => void closed++,
      };
    },
  };
  return { host, opened, encodes, codecs, sound, pages, closed: () => closed };
}

/** A pane ace-media delivers, on the client's media connection. */
const delivered = (viewport: Partial<CaptureViewer["viewport"]> = {}): CaptureViewer => ({
  viewport: { width: 640, height: 400, devicePixelRatio: 1, ...viewport },
  video: { codecs: [hevc, "avc1.42E033"] },
  delivered: true,
});

/** ace-media's plan for that view. */
const wanted: VideoEncode = {
  key: "media/1/avc1.42E033/320x200",
  codec: "avc1.42E033",
  width: 320,
  height: 200,
  fps: 15,
  bitrate: 150_000,
};

function watched(supported?: string[]) {
  let clock = 1_000;
  let changes = 0;
  const encoder = fakeHost(supported);
  const video = new LiveVideo({ now: () => clock, statusChanged: () => void changes++ });
  video.attach({ host: encoder.host, page }, "tab-1", { width: 640, height: 400, scale: 1 });
  /** Ticks the video every 50 ms for `milliseconds`, letting each open settle. */
  const run = async (milliseconds = 200) => {
    for (const until = clock + milliseconds; clock < until; clock += 50) {
      video.tick({ width: 640, height: 400 });
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    }
  };
  return { video, encoder, run, changes: () => changes, now: () => clock };
}

describe("a view ace-media delivers", () => {
  it("opens the capture with one encode at its picture, then runs exactly what ace-media wants", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    const events = t.encoder.opened[0];
    if (!events) throw new Error("no capture opened");
    // Before ace-media has a plan, one encode so it sees the source.
    expect(t.encoder.encodes[0]).toEqual([
      expect.objectContaining({ codec: "avc1.42E033", width: 640, height: 400 }),
    ]);
    events.want?.([wanted]);
    await t.run();
    expect(t.encoder.encodes.at(-1)).toEqual([wanted]);
  });

  it("tells ace-media the page's shape, and its new one when the tab is resized", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    expect(t.encoder.pages.at(-1)).toEqual({ width: 640, height: 400, scale: 1 });
    t.video.tick({ width: 800, height: 600 });
    expect(t.encoder.pages.at(-1)).toEqual({ width: 800, height: 600, scale: 1 });
  });

  it("tells ace-media the codecs its encoder runs, less one that failed", async () => {
    const t = watched([hevc, "avc1.42E033"]);
    t.video.add("phone", delivered());
    await t.run();
    expect(t.encoder.codecs).toEqual([[hevc, "avc1.42E033"]]);
    const planned = { ...wanted, key: `media/1/${hevc}/320x200`, codec: hevc };
    t.encoder.opened[0]?.want?.([planned]);
    await t.run();
    t.encoder.opened[0]?.failed(planned.key);
    await t.run();
    expect(t.encoder.codecs.at(-1)).toEqual(["avc1.42E033"]);
  });

  it("tries a codec whose encoder failed again once its cooldown is over", async () => {
    const t = watched([hevc, "avc1.42E033"]);
    t.video.add("phone", delivered());
    await t.run();
    const planned = { ...wanted, key: `media/1/${hevc}/320x200`, codec: hevc };
    t.encoder.opened[0]?.want?.([planned]);
    await t.run();
    t.encoder.opened[0]?.failed(planned.key);
    await t.run(failedCodecRetryMs - 500);
    expect(t.encoder.codecs.at(-1)).toEqual(["avc1.42E033"]);
    await t.run(1_000);
    expect(t.encoder.codecs.at(-1)).toEqual([hevc, "avc1.42E033"]);
  });

  it("waits longer for a codec that fails again and again, never more than a minute", async () => {
    const t = watched([hevc, "avc1.42E033"]);
    t.video.add("phone", delivered());
    await t.run();
    const planned = { ...wanted, key: `media/1/${hevc}/320x200`, codec: hevc };
    const waits: number[] = [];
    for (let failure = 0; failure < 7; failure++) {
      t.encoder.opened[0]?.failed(planned.key);
      await t.run(50);
      const failedAt = t.now();
      for (let turn = 0; turn < 300 && t.encoder.codecs.at(-1)?.[0] !== hevc; turn++)
        await t.run(250);
      waits.push(t.now() - failedAt);
    }
    expect(waits[1]).toBeGreaterThan(1.8 * (waits[0] ?? 0));
    expect(Math.max(...waits)).toBeLessThanOrEqual(61_000);
  });

  it("says the encoder is recovering while every codec a view takes failed, and nothing once it plays", async () => {
    const t = watched(["avc1.42E033"]);
    t.video.add("viewer", delivered());
    await t.run();
    const first = t.encoder.encodes[0]?.[0];
    if (!first) throw new Error("no encode");
    t.encoder.opened[0]?.failed(first.key);
    await t.run(50);
    expect(t.video.status()).toEqual({
      status: "retrying",
      reason: encoderRecovering,
      attempts: 1,
    });
    // Its cooldown over, the codec runs again and ace-media plans it: the video plays.
    for (let turn = 0; turn < 300 && t.encoder.encodes.length < 2; turn++) await t.run(250);
    expect(t.encoder.encodes.length).toBeGreaterThanOrEqual(2);
    t.encoder.opened.at(-1)?.want?.([wanted]);
    await t.run(50);
    expect(t.video.status()).toBeUndefined();
  });

  it("tells only the view whose every codec failed that the encoder is recovering", async () => {
    const t = watched([hevc, "avc1.42E033"]);
    t.video.add("hevc and h264", delivered());
    t.video.add("h264 only", { ...delivered(), video: { codecs: ["avc1.42E033"] } });
    await t.run();
    t.encoder.opened[0]?.failed("avc1.42E033/640x400");
    await t.run(50);
    expect(t.video.recoveringFor("h264 only")).toBe(true);
    expect(t.video.recoveringFor("hevc and h264")).toBe(false);
    expect(t.video.recoveringFor("nobody")).toBe(false);
  });

  it("starts at the top rate on this machine, and lower for a viewer elsewhere", async () => {
    const local = watched();
    local.video.add("viewer", delivered(), { local: true });
    await local.run();
    const remote = watched();
    remote.video.add("viewer", delivered());
    await remote.run();
    expect(local.encoder.encodes[0]?.[0]?.bitrate).toBeGreaterThan(
      remote.encoder.encodes[0]?.[0]?.bitrate ?? Infinity,
    );
  });

  it("stops the capture once every view is hidden, and opens one again when it shows", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    expect(t.video.watched()).toBe(true);
    t.video.configure("viewer", delivered({ paused: true }));
    await t.run();
    expect(t.video.watched()).toBe(false);
    expect(t.encoder.closed()).toBe(1);
    t.video.configure("viewer", delivered());
    await t.run();
    expect(t.encoder.opened).toHaveLength(2);
  });

  it("encodes the tab's sound only while a shown view listens", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    expect(t.encoder.sound).toEqual([]);
    t.video.configure("viewer", delivered({ audio: true }));
    await t.run();
    t.video.configure("viewer", delivered({ audio: false }));
    await t.run();
    expect(t.encoder.sound).toEqual([true, false]);
  });
});

describe("a view ace-media doesn't deliver", () => {
  it("never starts a capture: a client without a media connection gets no pictures", async () => {
    const t = watched();
    t.video.add("old", { viewport: delivered().viewport, video: { codecs: ["avc1.42E033"] } });
    await t.run();
    expect(t.video.watched()).toBe(false);
    expect(t.encoder.opened).toHaveLength(0);
  });

  it("stops counting a view that ace-media no longer delivers", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    t.video.configure("viewer", { ...delivered(), delivered: false });
    await t.run();
    expect(t.video.has("viewer")).toBe(false);
    expect(t.encoder.closed()).toBe(1);
  });
});

describe("a tab whose capture keeps ending before its first picture", () => {
  const noPicture = "The tab capture sent no picture";

  it("tries again later each time, longer every time, and says it is retrying", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
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
    for (let index = 1; index < waits.length; index++)
      expect(waits[index]).toBeGreaterThan(1.8 * (waits[index - 1] ?? 0));
    expect(t.changes()).toBe(4);
  });

  it("stops growing its wait at a minute", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    for (let failure = 1; failure <= 8; failure++) {
      const opens = t.encoder.opened.length;
      t.encoder.opened.at(-1)?.ended(noPicture);
      const endedAt = t.now();
      while (t.encoder.opened.length === opens) await t.run(1_000);
      expect(t.now() - endedAt).toBeLessThanOrEqual(61_000);
    }
  });

  it("plays again once ace-media plans the capture, and the next failure starts over", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    t.encoder.opened.at(-1)?.ended(noPicture);
    let opens = t.encoder.opened.length;
    while (t.encoder.opened.length === opens) await t.run(50);
    t.encoder.opened.at(-1)?.ended(noPicture);
    expect(t.video.status()?.attempts).toBe(2);
    opens = t.encoder.opened.length;
    while (t.encoder.opened.length === opens) await t.run(50);
    // ace-media plans only once it has the source's pictures: the capture plays.
    t.encoder.opened.at(-1)?.want?.([wanted]);
    expect(t.video.status()).toBeUndefined();
    expect(t.changes()).toBe(3);
    // A capture that played and then ended is no failure: it reopens on the next tick.
    opens = t.encoder.opened.length;
    t.encoder.opened.at(-1)?.ended();
    await t.run(100);
    expect(t.encoder.opened.length).toBe(opens + 1);
    expect(t.video.status()).toBeUndefined();
    t.encoder.opened.at(-1)?.ended(noPicture);
    expect(t.video.status()?.attempts).toBe(1);
  });

  it("closes a capture its encoder ended, so nothing it held stays behind", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    t.encoder.opened.at(-1)?.ended(noPicture);
    expect(t.encoder.closed()).toBe(1);
  });

  it("never keeps a capture that ended before its open finished, and opens another", async () => {
    const t = watched();
    const open = t.encoder.host.open;
    let early = true;
    t.encoder.host.open = async (cdp, width, height, events, privacy) => {
      const handle = await open(cdp, width, height, events, privacy);
      if (early) {
        early = false;
        events.ended(noPicture);
      }
      return handle;
    };
    t.video.add("viewer", delivered());
    await t.run();
    expect(t.encoder.closed()).toBe(1);
    expect(t.video.status()?.attempts).toBe(1);
    while (t.encoder.opened.length === 1) await t.run(50);
    expect(t.video.watched()).toBe(true);
  });

  it("starts afresh, without waiting, when the person shows another tab", async () => {
    const t = watched();
    t.video.add("viewer", delivered());
    await t.run();
    t.encoder.opened.at(-1)?.ended(noPicture);
    expect(t.video.status()?.attempts).toBe(1);
    const opens = t.encoder.opened.length;
    t.video.attach({ host: t.encoder.host, page }, "tab-2", { width: 640, height: 400, scale: 1 });
    expect(t.video.status()).toBeUndefined();
    await t.run(100);
    expect(t.encoder.opened.length).toBe(opens + 1);
  });
});
