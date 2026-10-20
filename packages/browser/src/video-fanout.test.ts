import { describe, expect, it } from "vitest";
import { VideoFanout, type VideoPiece } from "./video-fanout.ts";

interface Chunk extends VideoPiece {
  bytes: Uint8Array;
}

let sequence = 0;
const key = (size = 1000): Chunk => ({
  sequence: ++sequence,
  key: true,
  bytes: new Uint8Array(size),
});
const delta = (size = 100): Chunk => ({
  sequence: ++sequence,
  key: false,
  bytes: new Uint8Array(size),
});

function setup(window = { frames: 3, bytes: 10_000 }) {
  const keyframes: string[] = [];
  const playing: [string, boolean][] = [];
  const fanout = new VideoFanout<Chunk>({
    keyframe: (encode) => keyframes.push(encode),
    playing: (id, value) => playing.push([id, value]),
    window,
  });
  const viewer = (id: string, encode = "e1") => {
    const received: Chunk[] = [];
    let accepting = true;
    fanout.add(id, {
      send: (chunk) => {
        if (!accepting) return false;
        received.push(chunk);
        return true;
      },
    });
    fanout.assign(id, encode);
    return {
      received,
      ack: () => {
        const last = received.at(-1);
        if (last) fanout.acknowledge(id, last.sequence);
      },
      refuse: (value: boolean) => {
        accepting = !value;
      },
    };
  };
  return { fanout, keyframes, playing, viewer };
}

describe("video to each viewer at its own pace", () => {
  it("a viewer joining an encode starts at a keyframe and skips the deltas before it", () => {
    const { fanout, keyframes, playing, viewer } = setup();
    const phone = viewer("phone");
    expect(keyframes).toEqual(["e1"]);
    fanout.publish("e1", delta());
    expect(phone.received).toEqual([]);
    const first = key();
    fanout.publish("e1", first);
    fanout.publish("e1", delta());
    expect(phone.received.map((chunk) => chunk.key)).toEqual([true, false]);
    expect(phone.received[0]).toBe(first);
    expect(playing).toEqual([["phone", true]]);
  });

  it("deltas past the window are dropped until the next keyframe, which is asked for", () => {
    const { fanout, keyframes, viewer } = setup();
    const phone = viewer("phone");
    fanout.publish("e1", key());
    fanout.publish("e1", delta());
    fanout.publish("e1", delta());
    // The window holds three unacknowledged chunks: this one is dropped.
    fanout.publish("e1", delta());
    expect(phone.received).toHaveLength(3);
    expect(keyframes).toEqual(["e1", "e1"]);
    expect(fanout.backlogged("phone")).toBe(true);
    // Acked, but a later delta still can't be decoded without the one dropped.
    phone.ack();
    fanout.publish("e1", delta());
    expect(phone.received).toHaveLength(3);
    fanout.publish("e1", key());
    fanout.publish("e1", delta());
    expect(phone.received.slice(3).map((chunk) => chunk.key)).toEqual([true, false]);
    expect(fanout.backlogged("phone")).toBe(false);
  });

  it("a keyframe is never dropped: it waits for the window, newer ones replacing older", () => {
    const { fanout, viewer } = setup({ frames: 2, bytes: 10_000 });
    const phone = viewer("phone");
    fanout.publish("e1", key());
    fanout.publish("e1", delta());
    const stale = key();
    const fresh = key();
    fanout.publish("e1", stale);
    fanout.publish("e1", fresh);
    // Deltas after the waiting keyframe queue behind it.
    const after = delta();
    fanout.publish("e1", after);
    expect(phone.received).toHaveLength(2);
    phone.ack();
    expect(phone.received.slice(2)).toEqual([fresh, after]);
  });

  it("a lone keyframe larger than the byte window still goes, and fills it", () => {
    const { fanout, viewer } = setup({ frames: 8, bytes: 1_000 });
    const phone = viewer("phone");
    fanout.publish("e1", key(5_000));
    expect(phone.received).toHaveLength(1);
    fanout.publish("e1", delta());
    expect(phone.received).toHaveLength(1);
  });

  it("acks are cumulative: acking the newest frees everything before it", () => {
    const { fanout, viewer } = setup({ frames: 3, bytes: 10_000 });
    const phone = viewer("phone");
    fanout.publish("e1", key());
    fanout.publish("e1", delta());
    fanout.publish("e1", delta());
    phone.ack();
    fanout.publish("e1", delta());
    fanout.publish("e1", delta());
    fanout.publish("e1", delta());
    expect(phone.received).toHaveLength(6);
  });

  it("a slow viewer never holds back another viewer of the same encode", () => {
    const { fanout, viewer } = setup();
    const slow = viewer("slow");
    const fast = viewer("fast");
    fanout.publish("e1", key());
    for (let index = 0; index < 20; index++) {
      fanout.publish("e1", delta());
      fast.ack();
    }
    expect(fast.received).toHaveLength(21);
    expect(slow.received).toHaveLength(3);
  });

  it("a chunk the transport refused is sent again once it takes chunks", () => {
    const { fanout, viewer } = setup();
    const phone = viewer("phone");
    phone.refuse(true);
    const first = key();
    fanout.publish("e1", first);
    expect(phone.received).toEqual([]);
    phone.refuse(false);
    fanout.flush();
    expect(phone.received).toEqual([first]);
  });

  it("a viewer asking for a keyframe drops deltas until it gets one", () => {
    const { fanout, keyframes, viewer } = setup({ frames: 8, bytes: 10_000 });
    const phone = viewer("phone");
    fanout.publish("e1", key());
    fanout.keyframe("phone");
    expect(keyframes).toEqual(["e1", "e1"]);
    fanout.publish("e1", delta());
    expect(phone.received).toHaveLength(1);
    fanout.publish("e1", key());
    expect(phone.received).toHaveLength(2);
  });

  it("only the viewer's own encode reaches it, and moving encodes waits for the new keyframe", () => {
    const { fanout, keyframes, playing, viewer } = setup({ frames: 8, bytes: 10_000 });
    const phone = viewer("phone", "large");
    fanout.publish("large", key());
    fanout.publish("small", key());
    expect(phone.received).toHaveLength(1);
    fanout.assign("phone", "small");
    expect(keyframes.at(-1)).toBe("small");
    fanout.publish("small", delta());
    fanout.publish("large", delta());
    expect(phone.received).toHaveLength(1);
    fanout.publish("small", key());
    expect(phone.received).toHaveLength(2);
    // Still showing video throughout: its JPEG frames stay paused.
    expect(playing).toEqual([["phone", true]]);
  });

  it("a viewer whose video stops shows JPEG again", () => {
    const { fanout, playing, viewer } = setup();
    viewer("phone");
    viewer("tablet");
    fanout.publish("e1", key());
    fanout.stopAll();
    expect(playing).toEqual([
      ["phone", true],
      ["tablet", true],
      ["phone", false],
      ["tablet", false],
    ]);
    fanout.publish("e1", key());
    expect(fanout.playing("phone")).toBe(false);
  });
});

describe("a transport that acknowledges as it sends", () => {
  it("gets each chunk once", () => {
    const sent: number[] = [];
    const fanout: VideoFanout<{ sequence: number; key: boolean; bytes: Uint8Array }> =
      new VideoFanout({ keyframe: () => {}, playing: () => {} });
    fanout.add("viewer", {
      send: (chunk) => {
        sent.push(chunk.sequence);
        fanout.acknowledge("viewer", chunk.sequence);
        return true;
      },
    });
    fanout.assign("viewer", "encode");
    for (let number = 1; number <= 5; number++)
      fanout.publish("encode", {
        sequence: number,
        key: number === 1,
        bytes: new Uint8Array(100),
      });
    expect(sent).toEqual([1, 2, 3, 4, 5]);
  });
});
