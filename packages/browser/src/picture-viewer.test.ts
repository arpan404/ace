import { describe, expect, it } from "vitest";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import { streamKinds } from "./stream-envelope.ts";
import { PictureViewer, type CapturedPicture } from "./picture-viewer.ts";

const deviceId = "android:emulator-5554";

function frame(
  sequence: number,
  options: { key?: boolean; codec?: "jpeg" | "h264"; stream?: string; size?: number } = {},
): CapturedPicture {
  const jpeg = options.codec === "jpeg";
  return {
    sequence,
    timestamp: sequence * 33,
    width: 720,
    height: 1600,
    scale: 0.5,
    rotation: 0,
    codec: jpeg ? "jpeg" : "avc1.640028",
    key: jpeg || options.key === true,
    codecNamed: !jpeg,
    streamId: options.stream ?? "capture-1",
    bytes: new Uint8Array(options.size ?? 1000).fill(sequence % 256),
  };
}

function setup(options: { refuse?: () => boolean } = {}) {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const received: { sequence: number; key: boolean; stream: string; codec: string }[] = [];
  let keyframes = 0;
  let ids = 0;
  const assembler = new StreamAssembler();
  const viewer = new PictureViewer(streamKinds.deviceFrame, deviceId, {
    messageId: () => ++ids,
    now: () => now,
    after(ms, run) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    keyframe: () => keyframes++,
    // A small window, so tests reach its edge with a few pictures.
    window: { frames: 8, bytes: 2 * 1024 * 1024 },
    write(pieces) {
      if (options.refuse?.()) return false;
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind === "device.frame") {
          expect(message.sourceId).toBe(deviceId);
          received.push({
            sequence: message.frame.sequence,
            key: message.frame.key,
            stream: message.frame.streamId,
            codec: message.frame.codec,
          });
        }
      }
      return true;
    },
  });
  return {
    viewer,
    received,
    keyframes: () => keyframes,
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

describe("a source's pictures on the shared media stream", () => {
  it("holds a video viewer to its window until it acks, then carries on", () => {
    const view = setup();
    view.viewer.push(frame(1, { key: true }));
    for (let sequence = 2; sequence <= 8; sequence++) view.viewer.push(frame(sequence));
    expect(view.received.map((picture) => picture.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(view.received[0]).toMatchObject({
      key: true,
      codec: "avc1.640028",
      stream: "capture-1",
    });
    view.viewer.ack("capture-1", 4);
    view.viewer.push(frame(9));
    expect(view.received.at(-1)?.sequence).toBe(9);
    expect(view.keyframes()).toBe(1);
  });

  it("drops deltas a slow viewer has no room for and resumes it at the next keyframe", () => {
    const view = setup();
    view.viewer.push(frame(1, { key: true }));
    for (let sequence = 2; sequence <= 10; sequence++) view.viewer.push(frame(sequence));
    // Delta 9 didn't fit: it and every later delta wait out the keyframe it asked for.
    expect(view.received.map((picture) => picture.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    view.viewer.ack("capture-1", 8);
    view.viewer.push(frame(11));
    expect(view.received.at(-1)?.sequence).toBe(8);
    view.viewer.push(frame(12, { key: true }));
    view.viewer.push(frame(13));
    expect(view.received.slice(8).map((picture) => picture.sequence)).toEqual([12, 13]);
  });

  it("gives a slow JPEG viewer the newest picture once it acks", () => {
    const view = setup();
    for (let sequence = 1; sequence <= 12; sequence++)
      view.viewer.push(frame(sequence, { codec: "jpeg" }));
    expect(view.received.map((picture) => picture.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    view.viewer.ack("capture-1", 8);
    expect(view.received.slice(8).map((picture) => picture.sequence)).toEqual([12]);
    expect(view.received.every((picture) => picture.key && picture.codec === "jpeg")).toBe(true);
  });

  it("starts a new capture over at a keyframe and ignores acks for the old one", () => {
    const view = setup();
    view.viewer.push(frame(100, { key: true }));
    for (let sequence = 101; sequence <= 107; sequence++) view.viewer.push(frame(sequence));
    view.advance(1000);
    view.viewer.push(frame(1, { stream: "capture-2" }));
    expect(view.received.at(-1)?.stream).toBe("capture-1");
    expect(view.keyframes()).toBe(2);
    view.viewer.push(frame(2, { stream: "capture-2", key: true }));
    for (let sequence = 3; sequence <= 9; sequence++)
      view.viewer.push(frame(sequence, { stream: "capture-2" }));
    view.viewer.ack("capture-1", 500);
    view.viewer.push(frame(10, { stream: "capture-2" }));
    expect(view.received.filter((picture) => picture.stream === "capture-2").length).toBe(8);
  });

  it("asks for keyframes at most every half second, without losing a late request", () => {
    const view = setup();
    view.viewer.push(frame(1, { key: true }));
    expect(view.keyframes()).toBe(1);
    view.viewer.ack("capture-1", 1, true);
    expect(view.keyframes()).toBe(1);
    view.advance(499);
    expect(view.keyframes()).toBe(1);
    view.advance(1);
    expect(view.keyframes()).toBe(2);
  });

  it("a delta whose capture didn't name its codec is in its keyframe's", () => {
    const view = setup();
    view.viewer.push(frame(1, { key: true }));
    // A capture that names no codec on a delta: the default, until the keyframe's carries over.
    view.viewer.push({ ...frame(2), codec: "avc1.42E01F", codecNamed: false });
    expect(view.received.map((picture) => picture.codec)).toEqual(["avc1.640028", "avc1.640028"]);
  });

  it("retries what a backed-up transport refused once it drains", () => {
    let refuse = true;
    const view = setup({ refuse: () => refuse });
    view.viewer.push(frame(1, { key: true }));
    expect(view.received).toEqual([]);
    refuse = false;
    view.viewer.flush();
    expect(view.received.map((picture) => picture.sequence)).toEqual([1]);
  });
});

describe("a source whose capture restarts", () => {
  it("keeps the old capture's pictures in the window until they are acked", () => {
    const { viewer, received } = setup();
    // Eight pictures fill the window, none acked yet.
    for (let sequence = 1; sequence <= 8; sequence++)
      viewer.push(frame(sequence, { key: sequence === 1 }));
    // A new capture: its keyframe waits, as the old pictures are still on the wire.
    viewer.push(frame(1, { key: true, stream: "capture-2" }));
    expect(received.map((picture) => picture.stream)).toEqual(Array(8).fill("capture-1"));
    // The old capture's ack, named by its stream, releases them.
    viewer.ack("capture-1", 8);
    expect(received.at(-1)).toMatchObject({ stream: "capture-2", sequence: 1, key: true });
  });

  it("follows the link on the new capture's acks, whatever the old one left unacked", () => {
    let now = 0;
    const link = { min: 150_000, max: 20_000_000, initial: 4_000_000 };
    const viewer = new PictureViewer(streamKinds.deviceFrame, deviceId, {
      messageId: () => 1,
      now: () => now,
      after: () => () => {},
      keyframe: () => {},
      link,
      write: () => true,
    });
    for (let sequence = 100; sequence <= 105; sequence++)
      viewer.push(frame(sequence, { key: sequence === 100, size: 40_000 }));
    viewer.ack("capture-1", 102);
    // The new capture starts over at 1. The old one's last pictures are acked by its stream,
    // which frees the window but says nothing about the link now.
    viewer.push(frame(1, { key: true, stream: "capture-2", size: 40_000 }));
    viewer.ack("capture-1", 105);
    // 40 KB pictures acked as they go, for a second.
    for (let sequence = 1; sequence <= 60; sequence++) {
      if (sequence > 1) viewer.push(frame(sequence, { stream: "capture-2", size: 40_000 }));
      now += 1000 / 60;
      viewer.ack("capture-2", sequence);
    }
    expect(viewer.rate).toBeGreaterThan(link.initial);
  });
});

describe("a source whose captures restart many times", () => {
  it("still frees the first capture's window on its late ack, after more than four captures", () => {
    const { viewer, received } = setup();
    for (let sequence = 1; sequence <= 8; sequence++)
      viewer.push(frame(sequence, { key: sequence === 1 }));
    // Four more captures while the first one's eight pictures are still on the wire.
    for (const stream of ["capture-2", "capture-3", "capture-4", "capture-5"])
      viewer.push(frame(1, { key: true, stream }));
    expect(received).toHaveLength(8);
    viewer.ack("capture-1", 8);
    expect(received.at(-1)).toMatchObject({ stream: "capture-5", sequence: 1, key: true });
  });
});

describe("a source whose capture goes idle", () => {
  it("still lets a keyframe through once the unacked pictures ahead of it are due", () => {
    const { viewer, received, advance } = setup();
    for (let sequence = 1; sequence <= 8; sequence++)
      viewer.push(frame(sequence, { key: sequence === 1 }));
    viewer.push(frame(9, { key: true }));
    expect(received).toHaveLength(8);
    // Nothing more comes: no picture, ack or drain. The viewer wakes itself at the deadline.
    advance(3_000);
    expect(received).toHaveLength(8);
    advance(1_000);
    expect(received.at(-1)).toMatchObject({ sequence: 9, key: true });
  });

  it("cancels its wake-up when it closes", () => {
    const { viewer, advance, pending } = setup();
    viewer.push(frame(1, { key: true }));
    expect(pending()).toBe(1);
    viewer.close();
    expect(pending()).toBe(0);
    advance(10_000);
  });
});
