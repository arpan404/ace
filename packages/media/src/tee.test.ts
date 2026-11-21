import { expect, it } from "vitest";
import { decodeMediaFrame } from "./frame.ts";
import { MediaTee, teeQueueLimit, type IngestSocket, type TeeUnit } from "./tee.ts";
import type { ToMedia } from "./wire.ts";

function tee() {
  const sent: ToMedia[] = [];
  const written: Uint8Array[] = [];
  const state = { now: 0, queued: 0, keyframes: 0, connected: 0, destroyed: 0 };
  const lost: string[] = [];
  const closes: (() => void)[] = [];
  const socket: IngestSocket = {
    write: (bytes) => (written.push(bytes), true),
    get queued() {
      return state.queued;
    },
    destroy: () => void state.destroyed++,
    ready: Promise.resolve(),
    onClose: (listener) => void closes.push(listener),
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
      lost: (reason) => void lost.push(reason),
    },
    1,
  );
  const frames = () => written.map((bytes) => decodeMediaFrame(bytes));
  /** The socket ended on its own (ace-media closed it, or it failed). */
  const drop = () => {
    for (const close of closes.splice(0)) close();
  };
  return { media, sent, state, frames, lost, drop };
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
  expect((out[1]?.flags ?? 0) & 1).toBe(1);
});

it("asks the producer for a keyframe as soon as it connects, at start and after every reopen", () => {
  const { media, state } = tee();
  media.open();
  expect(state.keyframes).toBe(0);
  media.message({ type: "source.status", source: "s1", status: "starting" });
  expect(state.keyframes).toBe(1);
  // ace-media restarted: the daemon reopens the source in the new process.
  media.open();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  expect(state.keyframes).toBe(2);
});

it("is accepted only once ace-media binds the hello, never on the socket's own connect", async () => {
  const { media } = tee();
  media.open();
  const accepted = media.accepted();
  let settled: boolean | undefined;
  void accepted.then((ok) => (settled = ok));
  media.message({ type: "source.status", source: "s1", status: "starting" });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBeUndefined();
  media.message({ type: "source.ingest", source: "s2" });
  media.message({ type: "source.ingest", source: "s1" });
  await expect(accepted).resolves.toBe(true);
});

it("an acceptance still waiting is settled false by a reopen, a close or a lost connection", async () => {
  const { media, drop } = tee();
  media.open();
  const reopened = media.accepted();
  media.open();
  await expect(reopened).resolves.toBe(false);
  const closed = media.accepted();
  media.close();
  await expect(closed).resolves.toBe(false);
  media.open();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  const lost = media.accepted();
  drop();
  await expect(lost).resolves.toBe(false);
});

it("a sync asks ace-media for every frame written on the connection, and holds once it says so", async () => {
  const { media, sent, drop } = tee();
  media.open();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  media.message({ type: "source.ingest", source: "s1" });
  media.push(unit(true));
  media.push(unit(false));
  const held = media.sync(4);
  expect(sent.at(-1)).toEqual({ type: "source.sync", source: "s1", seq: 0, frames: 2, decided: 4 });
  media.message({ type: "source.synced", source: "s1", seq: 0 });
  await expect(held).resolves.toBe(true);
  // A connection lost first answers the barrier: it can't hold.
  const pending = media.sync(4);
  drop();
  await expect(pending).resolves.toBe(false);
});

it("an ingest connection that ends on its own is reported lost, and later units go nowhere", async () => {
  const { media, frames, lost, drop } = tee();
  media.open();
  const accepted = media.accepted();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  media.message({ type: "source.ingest", source: "s1" });
  await expect(accepted).resolves.toBe(true);
  media.push(unit(true));
  drop();
  expect(lost).toEqual(["ingest-closed"]);
  const before = frames().length;
  media.push(unit(true));
  expect(frames()).toHaveLength(before);
});

it("ace-media closing the producer is reported lost with its reason; the tee's own close isn't", () => {
  const { media, lost, drop } = tee();
  media.open();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  media.message({
    type: "source.status",
    source: "s1",
    status: "retrying",
    reason: "producer-closed",
    attempts: 1,
  });
  expect(lost).toEqual(["producer-closed"]);
  // Reopened, then closed by the tee itself: nothing is lost.
  media.open();
  media.message({ type: "source.status", source: "s1", status: "starting" });
  media.close();
  drop();
  expect(lost).toEqual(["producer-closed"]);
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
  const asked = state.keyframes;
  state.queued = teeQueueLimit + 1;
  media.push(unit(false));
  state.queued = 0;
  media.push(unit(false));
  media.push(unit(true));
  media.push(unit(false));
  expect(state.keyframes - asked).toBe(1);
  expect(
    frames()
      .slice(1)
      .map((f) => f.flags & 1),
  ).toEqual([1, 1, 0]);
});
