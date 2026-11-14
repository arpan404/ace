import { expect, it } from "vitest";
import { decodeMediaFrame } from "./frame.ts";
import { MediaTee, teeQueueLimit, type IngestSocket, type TeeUnit } from "./tee.ts";
import type { ToMedia } from "./wire.ts";

function tee() {
  const sent: ToMedia[] = [];
  const written: Uint8Array[] = [];
  const state = { now: 0, queued: 0, keyframes: 0, connected: 0 };
  const socket: IngestSocket = {
    write: (bytes) => (written.push(bytes), true),
    get queued() {
      return state.queued;
    },
    destroy: () => {},
  };
  const media = new MediaTee(
    {
      source: "s1",
      handle: () => 1,
      origin: { kind: "tab" },
      send: (message) => (sent.push(message), true),
      ingest: () => "/run/m1i.sock",
      connect: () => (state.connected++, socket),
      now: () => state.now,
      randomBytes: (n) => new Uint8Array(n).fill(9),
      keyframe: () => void state.keyframes++,
    },
    1,
  );
  const frames = () => written.map((bytes) => decodeMediaFrame(bytes));
  return { media, sent, state, frames };
}

const unit = (keyframe: boolean): TeeUnit => ({
  kind: "video",
  keyframe,
  codec: 2,
  width: 64,
  height: 64,
  payload: new Uint8Array([keyframe ? 1 : 0]),
});

it("connects only once ace-media has the source, and starts at a keyframe", () => {
  const { media, sent, state, frames } = tee();
  expect(media.open()).toBe(true);
  expect(sent[0]).toMatchObject({ type: "source.open", source: "s1", epoch: 1 });
  media.push(unit(true));
  expect(state.connected).toBe(0);
  media.message({ type: "source.status", source: "s1", status: "starting" });
  media.push(unit(false));
  media.push(unit(true));
  const out = frames();
  expect(out.map((f) => f.kind)).toEqual([5, 1]);
  expect(out[0]?.payload).toEqual(new Uint8Array(32).fill(9));
  expect(out[1]?.flags & 1).toBe(1);
});

it("stamps what it reads with the private epoch for 100 ms after a resume", () => {
  const { media, state, frames } = tee();
  media.open();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  media.push(unit(true));
  state.now = 1_000;
  media.epoch({ epoch: 2, followsPrivate: true });
  state.now = 1_099;
  media.push(unit(false));
  state.now = 1_100;
  media.push(unit(false));
  expect(
    frames()
      .slice(1)
      .map((f) => f.epoch),
  ).toEqual([1, 1, 2]);
});

it("drops deltas to the next keyframe while ace-media falls behind, and asks for one", () => {
  const { media, state, frames } = tee();
  media.open();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  media.push(unit(true));
  state.queued = teeQueueLimit + 1;
  media.push(unit(false));
  state.queued = 0;
  media.push(unit(false));
  media.push(unit(true));
  media.push(unit(false));
  expect(state.keyframes).toBe(1);
  expect(
    frames()
      .slice(1)
      .map((f) => f.flags & 1),
  ).toEqual([1, 1, 0]);
});
