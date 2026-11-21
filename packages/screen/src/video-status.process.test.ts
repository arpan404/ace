import { afterEach, expect, it } from "vitest";
import type { Frame } from "./frames.ts";
import { fakeScreenMedia, manager, ready } from "./testing/support.ts";

/*
 * A screen session's live video comes only through ace-media (X2), so its state says why when
 * it can't (`ScreenState.video`), and a JPEG-only helper still gets video: ace-media encodes its
 * pictures. The real manager and a fake helper process; ace-media is faked at its edge.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const live = {
  codec: "h264" as const,
  maxWidth: 1280,
  maxHeight: 800,
  fps: 30,
  bitrate: 2_000_000,
};

it("a helper that makes only JPEG still gets live video: its pictures go to ace-media and the encode comes back", async () => {
  const ace = fakeScreenMedia();
  const f = await manager({ FAKE_V2: "1" }, { media: ace.media });
  cleanups.push(f.close);
  const state = await ready(f.screen);
  expect((await f.screen.capabilities(state.sessionId))?.codecs).toEqual(["jpeg"]);
  await ace.stream(state.sessionId);
  const video: Frame[] = [];
  const stop = f.screen.subscribeEvery(state.sessionId, (frame) => {
    if (frame.header.codec === "h264") video.push(frame);
  });
  cleanups.push(async () => stop());
  expect(await f.screen.configureStream(state.sessionId, live)).toEqual({ codec: "h264" });
  ace.unit(state.sessionId, 1, true);
  await expect.poll(() => video.length).toBe(1);
  expect(video[0]?.header).toMatchObject({ codec: "h264", keyframe: true });
  expect(f.screen.state(state.sessionId).video).toBeUndefined();
});

it("while ace-media can't carry a session's video its state says why, and the first picture after clears it", async () => {
  const ace = fakeScreenMedia();
  const f = await manager({ FAKE_V2: "1", FAKE_VIDEO: "1" }, { media: ace.media });
  cleanups.push(f.close);
  const state = await ready(f.screen);
  await ace.stream(state.sessionId);
  await f.screen.configureStream(state.sessionId, live);
  const states: unknown[] = [];
  f.screen.watch((next) => void states.push(next.video));
  ace.stop(state.sessionId, "ace-media stopped and is starting again", "retrying");
  expect(f.screen.state(state.sessionId).video).toEqual({
    status: "retrying",
    reason: "ace-media stopped and is starting again",
  });
  ace.unit(state.sessionId, 1, true);
  await expect.poll(() => f.screen.state(state.sessionId).video).toBeUndefined();
  expect(states.at(-1)).toBeUndefined();
});

it("without ace-media a view that asks for live video is told why, and agents keep their stills", async () => {
  const f = await manager({ FAKE_V2: "1", FAKE_VIDEO: "1" });
  cleanups.push(f.close);
  const state = await ready(f.screen);
  expect(await f.screen.configureStream(state.sessionId, live)).toEqual({ codec: "jpeg" });
  expect(f.screen.state(state.sessionId).video).toEqual({
    status: "unavailable",
    reason: "ace-media isn't available on this computer",
  });
  const shot = await f.screen.captureScreenshot(state.sessionId);
  expect(shot.header.codec).toBe("jpeg");
});
