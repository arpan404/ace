import { expect, it } from "vitest";
import { fakeMediaRuntime } from "@ace/media/testing/fake-runtime";
import type { BrowserCdp, VideoCaptureHandle, VideoHost, VideoIngestTarget } from "./backend.ts";
import { mediaVideoHost, type BrowserMedia } from "./media-video.ts";
import type { VideoEncode } from "./backend.ts";

/*
 * X2's recovery through the browser's real producer adapter (`media-video.ts`): the daemon's
 * MediaRuntime with ace-media faked at its lanes. ace-media is killed; the producer's part of
 * recovery counts once the new process has opened the source again and the capture's encoder is
 * pointed at its new ingest with a new token. ace-media alone delivers the picture after that
 * (X3), which `media-video.process.test.ts` measures end to end on the real binary.
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
  /** The tab's encoder: its ingest target now (and each, timed), and its encodes' ids. */
  let target: VideoIngestTarget | undefined;
  const pointed: { at: number; target: VideoIngestTarget }[] = [];
  let encodes: readonly VideoEncode[] = [];
  const host: VideoHost = {
    mediaKind: "tab",
    supported: (codecs) => Promise.resolve([...codecs]),
    open: () =>
      Promise.resolve<VideoCaptureHandle>({
        encodes: (specs) => void (encodes = specs),
        keyframe: () => {},
        ingest: (next) => {
          target = next;
          if (next) pointed.push({ at: ace.clock.now(), target: next });
        },
        close: () => {},
      }),
  };
  const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, {
    chunk: () => {},
    failed: () => {},
    ended: () => {},
  });
  handle.encodes([spec]);
  await ace.run(
    5_000,
    () => target !== undefined,
    () => {},
  );
  const first = target?.token;
  expect(first, "the encoder streams into the first ace-media").toBeDefined();
  const killed = ace.clock.now();
  ace.kill();
  const moved = () => pointed.find((p) => p.at > killed && p.target.token !== first);
  await ace.run(
    10_000,
    () => moved() !== undefined,
    () => {},
  );
  const back = moved();
  expect(back, "the encoder was pointed at the new ingest").toBeDefined();
  // Its encodes run again there, under the ids the capture stamped.
  expect(encodes.map((e) => e.key)).toContain("avc1/640");
  handle.close();
  ace.dispose();
  return (back?.at ?? Infinity) - killed;
}

it("ace-media killed: a tab's encoder is pointed at the new process's ingest within 2 s p95", async () => {
  const delays: number[] = [];
  for (let n = 0; n < 20; n++) delays.push(await trial(n / 19));
  const sorted = delays.toSorted((a, b) => a - b);
  expect(sorted[Math.ceil(sorted.length * 0.95) - 1]).toBeLessThan(2_000);
  expect(sorted.every(Number.isFinite)).toBe(true);
});
