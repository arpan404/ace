import { expect, it } from "vitest";
import { fakeMediaRuntime } from "@ace/media/testing/fake-runtime";
import type {
  BrowserCdp,
  EncodedChunk,
  VideoCaptureHandle,
  VideoHost,
  VideoIngestTarget,
} from "./backend.ts";
import { mediaVideoHost, type BrowserMedia } from "./media-video.ts";
import type { VideoEncode } from "./video-policy.ts";

/*
 * X2's recovery acceptance through the browser's real producer adapter (`media-video.ts`): the
 * daemon's MediaRuntime with ace-media faked at its lanes. ace-media is killed; recovery counts
 * only once the capture's encoder has been pointed at the new ingest and a decodable keyframe from
 * the new process has reached the capture's own listener.
 */

const page = {} as BrowserCdp;
const spec: VideoEncode = {
  key: "avc1/640",
  codec: "avc1.42E033",
  width: 640,
  height: 400,
  fps: 60,
  bitrate: 4_000_000,
};

async function trial(random: number) {
  const ace = fakeMediaRuntime(random);
  const media: BrowserMedia = {
    add: (producer) => ace.runtime.sources.add(producer),
    routed: (kind) => ace.runtime.sources.routed(kind),
    wanted: (kind) => ace.runtime.sources.wanted(kind),
    pictureCodecs: () => [],
    endpoint: () => ace.runtime.sources.endpoint(),
  };
  /** The tab's encoder: its ingest target now, and the ids its encodes were stamped with. */
  let target: VideoIngestTarget | undefined;
  let encodes: readonly VideoEncode[] = [];
  const host: VideoHost = {
    mediaKind: "tab",
    supported: (codecs) => Promise.resolve([...codecs]),
    open: () =>
      Promise.resolve<VideoCaptureHandle>({
        encodes: (specs) => void (encodes = specs),
        keyframe: () => {},
        ingest: (next) => void (target = next),
        close: () => {},
      }),
  };
  const keys: { at: number; chunk: EncodedChunk }[] = [];
  const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, {
    chunk: (chunk) => void keys.push({ at: ace.clock.now(), chunk }),
    failed: () => {},
    ended: () => {},
  });
  handle.encodes([spec]);
  /** ace-media's side: once the encoder streams to an open, its first keyframe comes back. */
  const sent = new Set<number>();
  const streams = () => {
    const open = ace.opens().at(-1);
    const id = encodes[0]?.id;
    if (!open || !target || id === undefined || sent.has(open.handle)) return;
    sent.add(open.handle);
    ace.keyframe(open.handle, id);
  };
  await ace.run(5_000, () => keys.length > 0, streams);
  expect(keys[0]?.chunk).toMatchObject({ key: true, encode: "avc1/640" });
  const first = target?.token;
  const killed = ace.clock.now();
  ace.kill();
  await ace.run(10_000, () => keys.some((k) => k.at > killed && k.chunk.key), streams);
  const back = keys.find((k) => k.at > killed && k.chunk.key);
  expect(target?.token, "the encoder was pointed at the new ingest").not.toBe(first);
  handle.close();
  ace.dispose();
  return (back?.at ?? Infinity) - killed;
}

it("ace-media killed: a tab's encoder is pointed at the new ingest and its picture is back within 2 s p95", async () => {
  const delays: number[] = [];
  for (let n = 0; n < 20; n++) delays.push(await trial(n / 19));
  const sorted = delays.toSorted((a, b) => a - b);
  expect(sorted[Math.ceil(sorted.length * 0.95) - 1]).toBeLessThan(2_000);
  expect(sorted.every(Number.isFinite)).toBe(true);
});
