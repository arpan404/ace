import { expect, it } from "vitest";
import { fakeMediaRuntime } from "@ace/media/testing/fake-runtime";
import type { Frame } from "./frames.ts";
import { ScreenMediaSource } from "./media-source.ts";

/*
 * X2's recovery acceptance through the screen's real producer adapter (`ScreenMediaSource`) and
 * the daemon's MediaRuntime, with ace-media faked at its lanes and the helper scripted. After a
 * kill, recovery counts only once the helper has been given the new ingest and a decodable
 * keyframe from the new process reached the session.
 */

async function trial(random: number) {
  const ace = fakeMediaRuntime(random);
  /** The ingest the helper writes to now, as its last `stream.configure` named it. */
  let ingest: string | undefined;
  const accepted: { at: number; frame: Frame }[] = [];
  const source = new ScreenMediaSource({
    sessionId: "s1",
    platform: "macos",
    codecs: ["jpeg", "h264"],
    helper: {
      capabilities: undefined,
      permissions: async () => ({ screenRecording: true, accessibility: true }),
      requestV2: async () => ({}),
      request: async (command) => {
        if (command.op !== "stream.configure") return {};
        ingest = "ingest" in command ? command.ingest?.token : undefined;
        return { codec: command.settings.codec, ingest: ingest ? "on" : "off", switched: true };
      },
    },
    media: ace.media,
    accept: (frame) => void accepted.push({ at: ace.clock.now(), frame }),
    schedule: (callback, ms) => ace.clock.setTimeout(callback, ms),
  });
  await source.configure({
    codec: "h264",
    maxWidth: 1280,
    maxHeight: 800,
    fps: 30,
    bitrate: 2_000_000,
  });
  const sent = new Set<number>();
  const streams = () => {
    const open = ace.opens().at(-1);
    if (!open || !ingest || sent.has(open.handle)) return;
    sent.add(open.handle);
    ace.keyframe(open.handle);
  };
  const keys = (after: number) =>
    accepted.filter((a) => a.at > after && a.frame.header.keyframe === true);
  await ace.run(5_000, () => keys(-1).length > 0, streams);
  const first = ingest;
  const killed = ace.clock.now();
  ace.kill();
  await ace.run(10_000, () => keys(killed).length > 0, streams);
  expect(ingest, "the helper was given the new ingest").not.toBe(first);
  source.close();
  ace.dispose();
  return (keys(killed)[0]?.at ?? Infinity) - killed;
}

it("ace-media killed: a screen helper is given the new ingest and the picture is back within 2 s p95", async () => {
  const delays: number[] = [];
  for (let n = 0; n < 20; n++) delays.push(await trial(n / 19));
  const sorted = delays.toSorted((a, b) => a - b);
  expect(sorted.every(Number.isFinite)).toBe(true);
  expect(sorted[Math.ceil(sorted.length * 0.95) - 1]).toBeLessThan(2_000);
});
