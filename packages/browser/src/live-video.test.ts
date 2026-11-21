import { describe, expect, it } from "vitest";
import type { BrowserCdp, CaptureEvents, VideoEncode, VideoHost } from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { LiveVideo } from "./live-video.ts";

const page: BrowserCdp = { send: async () => ({}), on: () => {}, off: () => {} };
const hevc = "hvc1.1.6.L153.B0";

/** An encoder that records what each capture is told, and lets the test drive its events. */
function fakeHost(supported = ["avc1.42E033"]) {
  const opened: CaptureEvents[] = [];
  const encodes: VideoEncode[][] = [];
  const codecs: string[][] = [];
  const sound: boolean[] = [];
  let closed = 0;
  const host: VideoHost = {
    supported: async (asked) => asked.filter((codec) => supported.includes(codec)),
    open: async (_page, _width, _height, events) => {
      opened.push(events);
      return {
        encodes: (specs) => encodes.push([...specs]),
        keyframe: () => {},
        codecs: (runs) => codecs.push([...runs]),
        audio: (on) => sound.push(on),
        close: () => void closed++,
      };
    },
  };
  return { host, opened, encodes, codecs, sound, closed: () => closed };
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
