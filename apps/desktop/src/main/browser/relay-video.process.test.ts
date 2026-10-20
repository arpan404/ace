import { afterEach, describe, expect, it } from "vitest";
import type { CaptureEvents, EncodedAudio, EncodedChunk } from "@ace/browser";
import { BrowserOpen } from "@ace/protocol";
import type { ViewHost } from "./backend.ts";
import { PageVideo, type EncodeSpec, type PageVideoHost } from "./page-video.ts";
import { connectDesktop, eventually, relayDaemon } from "./relay-test-support.ts";
import { fakeViews, groupViews, type FakePage } from "./test-support.ts";
import type { VideoRelayEvent, VideoRelaySource } from "./video-relay.ts";

/**
 * Remote viewers of a desktop view watch it as video (ADR 0088, embedded backend): the daemon's
 * relay drives the app's encoder over the real backend socket, and the encoder's chunks come
 * back as binary messages. The encoder itself (an Electron page) is the one stand-in: it
 * records what it is told and emits what a test makes it encode.
 */
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The app's encoder without Electron; a capture's source is the name of the view it shows. */
class FakeEncoder implements PageVideoHost<string>, VideoRelaySource {
  starts: { capture: string; source: string; width: number; height: number }[] = [];
  specs = new Map<string, readonly EncodeSpec[]>();
  keyframes: { capture: string; encode: string }[] = [];
  sound = new Map<string, boolean>();
  stopped: string[] = [];
  private events = new Set<(event: VideoRelayEvent, bytes: Uint8Array | undefined) => void>();
  private stops = new Set<(capture: string) => void>();
  async supported(codecs: readonly string[]): Promise<string[]> {
    return codecs.filter((codec) => codec.startsWith("avc1."));
  }
  async start(capture: string, source: string, width: number, height: number): Promise<void> {
    this.starts.push({ capture, source, width, height });
  }
  onStopped(listener: (capture: string) => void): () => void {
    this.stops.add(listener);
    return () => this.stops.delete(listener);
  }
  onEvent(listener: (event: VideoRelayEvent, bytes: Uint8Array | undefined) => void) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  encodes(capture: string, specs: readonly EncodeSpec[]): void {
    this.specs.set(capture, specs);
  }
  keyframe(capture: string, encode: string): void {
    this.keyframes.push({ capture, encode });
  }
  audio(capture: string, on: boolean): void {
    this.sound.set(capture, on);
  }
  stop(capture: string): void {
    this.stopped.push(capture);
    this.end(capture);
  }
  stopAll(): void {
    for (const { capture } of this.starts) if (!this.stopped.includes(capture)) this.stop(capture);
  }
  /** The capture ended by itself (its view closed): listeners hear it, as from the page. */
  end(capture: string): void {
    this.emit({ t: "ended", capture });
    for (const listener of this.stops) listener(capture);
  }
  emit(event: VideoRelayEvent & Record<string, unknown>, bytes?: Uint8Array): void {
    for (const listener of this.events) listener(event, bytes);
  }
}

/** Gives a fake view `ace.video.*`, as `EmbeddedPage` has with the app's encoder. */
function withVideo(page: FakePage, encoder: FakeEncoder, source: string): void {
  const video = new PageVideo(encoder, source, () => {});
  const cdp = page.cdp.bind(page);
  page.cdp = (method, params) => video.command(method, params) ?? cdp(method, params);
}

/** Views that answer `ace.video.*`, each capture naming its view by its session. */
function withEncoder(views: ReturnType<typeof fakeViews>, encoder: FakeEncoder): ViewHost {
  return {
    async open(request) {
      const page = await views.host.open(request);
      const fake = views.pages.get(request.sessionId);
      if (fake) withVideo(fake, encoder, request.sessionId);
      return page;
    },
  };
}

async function setup(video: boolean) {
  const daemon = await relayDaemon(cleanups);
  const views = fakeViews();
  const encoder = new FakeEncoder();
  const viewHost = withEncoder(views, encoder);
  const { home } = await connectDesktop(cleanups, daemon, viewHost, video ? encoder : undefined);
  const relay = daemon.relays.at(-1);
  if (!relay) throw new Error("not registered");
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const session = await relay.open({
    options: BrowserOpen.parse({ threadId: "t-1", workspaceId: "w-1", profile: "ephemeral" }),
    profileDir: home,
    signal: abort.signal,
    allowed: async () => true,
    navigation: () => {},
    log: () => {},
    lost: () => {},
  });
  return { daemon, encoder, session, views };
}

function watch() {
  const chunks: EncodedChunk[] = [];
  const audio: EncodedAudio[] = [];
  const failed: string[] = [];
  let ended = 0;
  const events: CaptureEvents = {
    chunk: (chunk) => chunks.push(chunk),
    audio: (chunk) => audio.push(chunk),
    failed: (encode) => failed.push(encode),
    ended: () => {
      ended++;
    },
  };
  return { events, chunks, audio, failed, ended: () => ended };
}

const spec: EncodeSpec = {
  key: "avc1.42E033@1280x800",
  codec: "avc1.42E033",
  width: 1280,
  height: 800,
  fps: 60,
  bitrate: 8_000_000,
};

describe("remote viewers of a desktop view watch it as video", () => {
  it("captures the view at the asked size and delivers its encoded chunks with their bytes", async () => {
    const { encoder, session } = await setup(true);
    const video = session.video?.();
    if (!video) throw new Error("The desktop's views have no video");
    expect(await video.supported(["vp8", "avc1.42E033"], 1280, 800)).toEqual(["avc1.42E033"]);
    const watcher = watch();
    const handle = await video.open(session.cdp, 1280, 800, watcher.events);
    expect(encoder.starts).toMatchObject([{ width: 1280, height: 800 }]);
    const capture = encoder.starts[0]?.capture ?? "";
    handle.encodes([spec]);
    await eventually(() => expect(encoder.specs.get(capture)).toEqual([spec]));
    const avcC = new Uint8Array([1, 66, 0, 51]);
    encoder.emit(
      {
        t: "chunk",
        capture,
        encode: spec.key,
        key: true,
        codec: "avc1.42E033",
        codedWidth: 1280,
        codedHeight: 800,
        description: Buffer.from(avcC).toString("base64"),
        age: 4,
      },
      new Uint8Array([0, 0, 0, 2, 9, 16]),
    );
    encoder.emit(
      {
        t: "chunk",
        capture,
        encode: spec.key,
        key: false,
        codec: "avc1.42E033",
        codedWidth: 1280,
        codedHeight: 800,
        age: 2,
      },
      new Uint8Array([0, 0, 0, 1, 7]),
    );
    await eventually(() => expect(watcher.chunks).toHaveLength(2));
    expect(watcher.chunks[0]).toMatchObject({
      encode: spec.key,
      key: true,
      codec: "avc1.42E033",
      codedWidth: 1280,
      codedHeight: 800,
      age: 4,
    });
    expect([...(watcher.chunks[0]?.description ?? [])]).toEqual([...avcC]);
    expect([...(watcher.chunks[0]?.bytes ?? [])]).toEqual([0, 0, 0, 2, 9, 16]);
    expect(watcher.chunks[1]?.key).toBe(false);
    expect(watcher.chunks[1]?.description).toBeUndefined();
    expect([...(watcher.chunks[1]?.bytes ?? [])]).toEqual([0, 0, 0, 1, 7]);
  });

  it("forwards keyframe, sound and stop requests to the capture", async () => {
    const { encoder, session } = await setup(true);
    const watcher = watch();
    const handle = await session.video?.()?.open(session.cdp, 640, 400, watcher.events);
    const capture = encoder.starts[0]?.capture ?? "";
    handle?.encodes([spec]);
    handle?.keyframe(spec.key);
    handle?.audio?.(true);
    await eventually(() => {
      expect(encoder.keyframes).toEqual([{ capture, encode: spec.key }]);
      expect(encoder.sound.get(capture)).toBe(true);
    });
    encoder.emit(
      { t: "audio", capture, codec: "opus", sampleRate: 48_000, channels: 2, age: 20 },
      new Uint8Array([252, 255, 254]),
    );
    await eventually(() =>
      expect(watcher.audio).toMatchObject([{ codec: "opus", sampleRate: 48_000, channels: 2 }]),
    );
    handle?.close();
    await eventually(() => expect(encoder.stopped).toEqual([capture]));
    // A capture the viewer closed reports nothing more.
    expect(watcher.ended()).toBe(0);
  });

  it("tells the viewer when the capture ends on the desktop, or the encode fails", async () => {
    const { encoder, session } = await setup(true);
    const watcher = watch();
    await session.video?.()?.open(session.cdp, 1280, 800, watcher.events);
    const capture = encoder.starts[0]?.capture ?? "";
    encoder.emit({ t: "failed", capture, encode: spec.key });
    await eventually(() => expect(watcher.failed).toEqual([spec.key]));
    encoder.end(capture);
    await eventually(() => expect(watcher.ended()).toBe(1));
  });

  it("ends every capture when the desktop link drops", async () => {
    const { daemon, encoder, session } = await setup(true);
    const watcher = watch();
    await session.video?.()?.open(session.cdp, 1280, 800, watcher.events);
    const capture = encoder.starts[0]?.capture ?? "";
    daemon.drop();
    await eventually(() => {
      expect(watcher.ended()).toBe(1);
      // The desktop stops encoding for a daemon that forgot the capture.
      expect(encoder.stopped).toEqual([capture]);
    });
  });

  it("captures the native tab the daemon names, not the shown one", async () => {
    const daemon = await relayDaemon(cleanups);
    const views = groupViews();
    const encoder = new FakeEncoder();
    const { home } = await connectDesktop(cleanups, daemon, views.host, encoder);
    const relay = daemon.relays.at(-1);
    if (!relay) throw new Error("not registered");
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const session = await relay.open({
      options: BrowserOpen.parse({ threadId: "t-1", workspaceId: "w-1", profile: "ephemeral" }),
      profileDir: home,
      signal: abort.signal,
      allowed: async () => true,
      navigation: () => {},
      log: () => {},
      lost: () => {},
    });
    // A second tab, opened behind the shown one.
    const second = (await session.tabs?.open({ background: true })) ?? "";
    expect(session.tabs?.active()).not.toBe(second);
    for (const [id, tab] of views.tabs) withVideo(tab, encoder, id);
    const page = session.tabs?.page?.(second);
    await page?.video?.()?.open(page.cdp, 800, 600, watch().events);
    expect(encoder.starts.map((start) => start.source)).toEqual([second]);
  });

  it("keeps a desktop without an encoder on JPEG", async () => {
    const { session } = await setup(false);
    expect(session.video?.()).toBeUndefined();
  });
});
