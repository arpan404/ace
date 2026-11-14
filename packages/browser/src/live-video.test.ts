import { describe, expect, it } from "vitest";
import type { BrowserCdp, CaptureEvents, VideoHost } from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { LiveVideo } from "./live-video.ts";
import type { MediaLinkHint } from "@ace/protocol";
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

async function firstEncode(local: boolean, hint?: MediaLinkHint): Promise<VideoEncode | undefined> {
  const encoder = fakeHost();
  const video = new LiveVideo({ now: () => 1_000, playing: () => {} });
  video.attach({ host: encoder.host, page }, "tab-1", { width: 659, height: 825, scale: 2 });
  const pane = hint
    ? { ...retinaPane, viewport: { ...retinaPane.viewport, link: hint } }
    : retinaPane;
  video.add("viewer", { send: () => true }, pane, undefined, { local });
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
    expect(encode?.fps).toBe(60);
    expect(encode?.bitrate).toBeLessThanOrEqual(1_500_000);
  });

  it("a viewer whose client says it is on 3G starts at a low step: fewer frames first", async () => {
    const encode = await firstEncode(false, { effectiveType: "3g" });
    expect(encode?.fps).toBe(5);
    expect(encode?.bitrate).toBe(500_000);
    // Its keyframe fits half a second of the link: the picture is smaller, not mushy.
    expect((encode?.width ?? 0) * (encode?.height ?? 0) * 0.25).toBeLessThanOrEqual(250_000);
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

/** A remote phone viewer, with what its client says about its link. */
function phone(link?: CaptureViewer["viewport"]["link"]): CaptureViewer {
  return {
    viewport: { width: 659, height: 825, devicePixelRatio: 2, ...(link ? { link } : {}) },
    video: { codecs: ["avc1.42E033"] },
  };
}

async function startRate(capture: CaptureViewer, local = false): Promise<number | undefined> {
  const encoder = fakeHost();
  const video = new LiveVideo({ now: () => 1_000, playing: () => {} });
  video.attach({ host: encoder.host, page }, "tab-1", { width: 659, height: 825, scale: 2 });
  video.add("viewer", { send: () => true }, capture, undefined, local);
  for (let index = 0; index < 4; index++) {
    video.tick({ width: 659, height: 825 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return encoder.encodes[0]?.[0]?.bitrate;
}

describe("a viewer's link hint", () => {
  it("starts a viewer on a slow or spared link lower than an unhinted one", async () => {
    const unhinted = (await startRate(phone())) ?? 0;
    for (const link of [
      { effectiveType: "3g" },
      { effectiveType: "3G" },
      { effectiveType: "Slow-2G" },
      { effectiveType: "slow-2g" },
      { saveData: true },
      { constrained: true },
      { rttMs: 450 },
      { downlinkKbps: 400 },
    ])
      expect(await startRate(phone(link))).toBeLessThan(unhinted);
  });

  it("never starts a viewer higher than it would start without one", async () => {
    const unhinted = await startRate(phone());
    expect(
      await startRate(phone({ effectiveType: "4g", downlinkKbps: 10_000_000, rttMs: 0 })),
    ).toBe(unhinted);
  });

  it("leaves a viewer on this machine at loopback's rate", async () => {
    expect(await startRate(phone({ saveData: true }), true)).toBe(await startRate(phone(), true));
  });

  it("never moves the rate of a viewer whose link is already running", async () => {
    let clock = 1_000;
    const encoder = fakeHost();
    const video = new LiveVideo({ now: () => clock, playing: () => {} });
    video.attach({ host: encoder.host, page }, "tab-1", { width: 659, height: 825, scale: 2 });
    video.add("viewer", { send: () => true }, phone());
    const run = async () => {
      for (let index = 0; index < 4; index++, clock += 50) {
        video.tick({ width: 659, height: 825 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await run();
    const before = encoder.encodes.at(-1)?.[0]?.bitrate;
    video.add("viewer", { send: () => true }, phone({ saveData: true }));
    video.configure("viewer", phone({ effectiveType: "slow-2g" }));
    clock += 1_000;
    await run();
    expect(encoder.encodes.at(-1)?.[0]?.bitrate).toBe(before);
  });
});

function hidden(): CaptureViewer {
  const viewer = phone();
  return { ...viewer, viewport: { ...viewer.viewport, paused: true } };
}

/** Two viewers of one tab, whose capture the test feeds by hand. */
async function twoViewers() {
  let clock = 1_000;
  const opened: CaptureEvents[] = [];
  const keyframes: string[] = [];
  let closed = 0;
  const host: VideoHost = {
    supported: async () => ["avc1.42E033"],
    open: async (_page, _width, _height, events) => {
      opened.push(events);
      return {
        encodes: () => {},
        keyframe: (encode) => void keyframes.push(encode),
        close: () => void closed++,
      };
    },
  };
  const received = { desk: [] as boolean[], phone: [] as boolean[] };
  const video = new LiveVideo({ now: () => clock, playing: () => {} });
  video.attach({ host, page }, "tab-1", { width: 659, height: 825, scale: 2 });
  for (const id of ["desk", "phone"] as const)
    video.add(
      id,
      {
        send: (chunk) => {
          received[id].push(chunk.key);
          // Acknowledged at once, so the window never fills.
          queueMicrotask(() => video.acknowledge(id, chunk.sequence));
          return true;
        },
      },
      phone(),
    );
  const run = async () => {
    for (let index = 0; index < 4; index++, clock += 50) {
      video.tick({ width: 659, height: 825 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** A chunk of the open capture's encode (the first one a keyframe was asked of). */
  const live = (key: boolean) =>
    opened.at(-1)?.chunk({
      encode: keyframes[0] ?? "",
      key,
      codec: "avc1.42E033",
      codedWidth: 658,
      codedHeight: 824,
      bytes: new Uint8Array(100),
    });
  return { video, run, live, received, keyframes, closed: () => closed };
}

describe("a paused viewer", () => {
  it("is sent no video while hidden, and starts again at a keyframe", async () => {
    const t = await twoViewers();
    await t.run();
    expect(t.keyframes.length).toBeGreaterThan(0);
    const live = t.live;
    live(true);
    live(false);
    expect(t.received.phone).toEqual([true, false]);
    t.video.configure("phone", hidden());
    await t.run();
    live(false);
    live(true);
    live(false);
    expect(t.received.phone).toEqual([true, false]);
    expect(t.received.desk).toEqual([true, false, false, true, false]);
    const asked = t.keyframes.length;
    t.video.configure("phone", phone());
    await t.run();
    expect(t.keyframes.length).toBeGreaterThan(asked);
    live(false);
    expect(t.received.phone).toEqual([true, false]);
    live(true);
    live(false);
    expect(t.received.phone).toEqual([true, false, true, false]);
  });

  it("stops the tab's sound while the only listener is hidden, and starts it on resume", async () => {
    let clock = 1_000;
    const sound: boolean[] = [];
    const host: VideoHost = {
      supported: async () => ["avc1.42E033"],
      open: async () => ({
        encodes: () => {},
        keyframe: () => {},
        audio: (on) => void sound.push(on),
        close: () => {},
      }),
    };
    const video = new LiveVideo({ now: () => clock, playing: () => {} });
    video.attach({ host, page }, "tab-1", { width: 659, height: 825, scale: 2 });
    const listening = (paused: boolean): CaptureViewer => {
      const viewer = phone();
      return { ...viewer, viewport: { ...viewer.viewport, audio: true, paused } };
    };
    video.add("desk", { send: () => true }, phone());
    video.add("phone", { send: () => true }, listening(false), { send: () => true });
    const run = async () => {
      for (let index = 0; index < 4; index++, clock += 50) {
        video.tick({ width: 659, height: 825 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await run();
    video.configure("phone", listening(true));
    await run();
    video.configure("phone", listening(false));
    await run();
    expect(sound).toEqual([true, false, true]);
  });

  it("stops the capture once every viewer is hidden, and nobody counts as watching", async () => {
    const t = await twoViewers();
    await t.run();
    expect(t.video.watched()).toBe(true);
    for (const id of ["desk", "phone"]) t.video.configure(id, hidden());
    expect(t.video.watched()).toBe(false);
    await t.run();
    expect(t.closed()).toBeGreaterThan(0);
  });
});
