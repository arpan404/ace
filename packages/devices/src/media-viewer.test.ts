import { describe, expect, it } from "vitest";
import { decodeStreamMessage, StreamAssembler } from "@ace/browser/stream";
import { framePacket, type Frame } from "@ace/screen";
import { DeviceMediaViewer } from "./media-viewer.ts";

const deviceId = "android:emulator-5554";

function frame(
  sequence: number,
  options: { key?: boolean; codec?: "jpeg" | "h264"; stream?: string; size?: number } = {},
): Frame {
  const payload = Buffer.alloc(options.size ?? 1000, sequence % 256);
  const codec = options.codec ?? "h264";
  const header = {
    version: 1 as const,
    sessionId: options.stream ?? "capture-1",
    sequence,
    timestamp: sequence * 33,
    width: 720,
    height: 1600,
    codec,
    ...(codec === "h264" ? { keyframe: options.key ?? false, videoCodec: "avc1.640028" } : {}),
    scale: 0.5,
    bytes: payload.length,
  };
  return { header, payload, packet: framePacket(header, payload) };
}

function setup(options: { refuse?: () => boolean } = {}) {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const received: { sequence: number; key: boolean; stream: string; codec: string }[] = [];
  let keyframes = 0;
  let ids = 0;
  const assembler = new StreamAssembler();
  const viewer = new DeviceMediaViewer(deviceId, {
    messageId: () => ++ids,
    now: () => now,
    after(ms, run) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    keyframe: () => keyframes++,
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
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

describe("a device's pictures on the shared media stream", () => {
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
    const delta = frame(2);
    const { videoCodec: _named, ...unnamed } = delta.header;
    view.viewer.push({ ...delta, header: unnamed });
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
