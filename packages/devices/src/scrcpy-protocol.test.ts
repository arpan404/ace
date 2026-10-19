import { describe, expect, it } from "vitest";
import {
  DeviceMessageReader,
  VideoStreamReader,
  encodeControl,
  scrcpyMaxSize,
  scrcpyServerArgs,
  scrcpySocketName,
  type DeviceMessage,
  type VideoEvent,
} from "./scrcpy-protocol.ts";

const hex = (buffer: Buffer) => buffer.toString("hex");

describe("control messages use the pinned server's byte layout", () => {
  it("a finger touch carries its pointer id, position, frame size and full pressure", () => {
    const bytes = encodeControl({
      type: "touch",
      action: "down",
      pointerId: 1n,
      x: 100,
      y: 200,
      screen: { width: 1080, height: 1920 },
      pressure: 1,
    });
    expect(hex(bytes)).toBe(
      [
        "02", // inject touch
        "00", // ACTION_DOWN
        "0000000000000001", // pointer id
        "00000064000000c8", // x, y
        "04380780", // frame width, height
        "ffff", // pressure 1.0
        "0000000000000000", // no mouse buttons
      ].join(""),
    );
  });

  it("text is UTF-8 with a 32-bit length and refuses more than the server accepts", () => {
    expect(hex(encodeControl({ type: "text", text: "testé" }))).toBe(
      `0100000006${Buffer.from("testé").toString("hex")}`,
    );
    expect(() => encodeControl({ type: "text", text: "a".repeat(301) })).toThrow(RangeError);
  });

  it("a keycode carries action, code, repeat and meta state", () => {
    expect(hex(encodeControl({ type: "keycode", action: "up", keycode: 66 }))).toBe(
      ["00", "01", "00000042", "00000000", "00000000"].join(""),
    );
  });

  it("set clipboard carries its sequence and paste flag ahead of the text", () => {
    expect(
      hex(encodeControl({ type: "setClipboard", sequence: 7n, text: "👋", paste: true })),
    ).toBe(
      ["09", "0000000000000007", "01", "00000004", Buffer.from("👋").toString("hex")].join(""),
    );
  });

  it("scroll amounts are signed fixed point over ±16", () => {
    const bytes = encodeControl({
      type: "scroll",
      x: 260,
      y: 1026,
      screen: { width: 1080, height: 1920 },
      dx: 0,
      dy: -16,
    });
    expect(hex(bytes)).toBe(
      ["03", "00000104", "00000402", "0438", "0780", "0000", "8000", "00000000"].join(""),
    );
  });

  it("one-byte commands: back or screen on, clipboard read, rotation and video reset", () => {
    expect(hex(encodeControl({ type: "backOrScreenOn", action: "down" }))).toBe("0400");
    expect(hex(encodeControl({ type: "getClipboard" }))).toBe("0800");
    expect(hex(encodeControl({ type: "rotate" }))).toBe("0b");
    expect(hex(encodeControl({ type: "resetVideo" }))).toBe("11");
  });
});

function media(flags: number, pts: number, payload: number[]) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64BE((BigInt(flags) << 56n) | BigInt(pts), 0);
  head.writeUInt32BE(payload.length, 8);
  return Buffer.concat([head, Buffer.from(payload)]);
}
function session(width: number, height: number) {
  const head = Buffer.alloc(12);
  head.writeUInt8(0x80, 0);
  head.writeUInt32BE(width, 4);
  head.writeUInt32BE(height, 8);
  return head;
}

describe("the video socket is split into codec, session and media packets", () => {
  it("reads the same events whether bytes arrive whole or one at a time", () => {
    const stream = Buffer.concat([
      Buffer.from("h264"),
      session(576, 1280),
      media(0x40, 0, [0, 0, 0, 1, 0x67]),
      media(0x20, 16_666, [1, 2, 3]),
      media(0x00, 33_333, [4]),
    ]);
    const whole: VideoEvent[] = [];
    new VideoStreamReader((event) => whole.push(event)).push(stream);
    const split: VideoEvent[] = [];
    const reader = new VideoStreamReader((event) => split.push(event));
    for (const byte of stream) reader.push(Buffer.from([byte]));
    expect(split).toEqual(whole);
    expect(whole).toEqual([
      { type: "codec", id: 0x68323634 },
      { type: "session", width: 576, height: 1280 },
      {
        type: "packet",
        config: true,
        keyframe: false,
        pts: 0n,
        payload: Buffer.from([0, 0, 0, 1, 0x67]),
      },
      {
        type: "packet",
        config: false,
        keyframe: true,
        pts: 16_666n,
        payload: Buffer.from([1, 2, 3]),
      },
      { type: "packet", config: false, keyframe: false, pts: 33_333n, payload: Buffer.from([4]) },
    ]);
  });

  it("refuses a packet larger than the frame budget before buffering it", () => {
    const head = Buffer.alloc(12);
    head.writeUInt32BE(9 * 1024 * 1024, 8);
    const reader = new VideoStreamReader(() => {});
    reader.push(Buffer.from("h264"));
    expect(() => reader.push(head)).toThrow("exceeds limit");
  });
});

describe("device messages", () => {
  it("clipboard text and paste acknowledgements survive arbitrary chunking", () => {
    const text = Buffer.from("aéûoç");
    const clipboard = Buffer.concat([Buffer.from([0, 0, 0, 0, text.length]), text]);
    const ack = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 9]);
    const bytes = Buffer.concat([clipboard, ack]);
    const messages: DeviceMessage[] = [];
    const reader = new DeviceMessageReader((message) => messages.push(message));
    reader.push(bytes.subarray(0, 3));
    reader.push(bytes.subarray(3, 12));
    reader.push(bytes.subarray(12));
    expect(messages).toEqual([
      { type: "clipboard", text: "aéûoç" },
      { type: "clipboardAck", sequence: 9n },
    ]);
  });

  it("an unknown message stops reading, since its length cannot be known", () => {
    const messages: DeviceMessage[] = [];
    const reader = new DeviceMessageReader((message) => messages.push(message));
    reader.push(Buffer.from([0x7f, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
    reader.push(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 2]));
    expect(messages).toEqual([{ type: "unknown", code: 0x7f }]);
  });
});

describe("server start-up", () => {
  it("names the abstract socket from the session id in eight hex digits", () => {
    expect(scrcpySocketName(0x1234)).toBe("scrcpy_00001234");
  });

  it("asks for H.264 video and control, no audio, over a forward tunnel at the viewer's budget", () => {
    const args = scrcpyServerArgs("5.0.1", {
      scid: 0xabc,
      maxSize: 1280,
      bitrate: 4_000_000,
      fps: 60,
    });
    expect(args[0]).toBe("5.0.1");
    expect(args).toEqual(
      expect.arrayContaining([
        "scid=00000abc",
        "video=true",
        "audio=false",
        "control=true",
        "tunnel_forward=true",
        "video_codec=h264",
        "max_size=1280",
        "video_bit_rate=4000000",
        "max_fps=60",
      ]),
    );
  });

  it("fits the display in the viewer's box and in a frame header, never upscaling", () => {
    const portrait = { width: 1080, height: 2400 };
    expect(scrcpyMaxSize(portrait, { maxWidth: 540, maxHeight: 3840 })).toBe(1200);
    // Frame headers allow 2160 rows, so a tall phone is bounded even in a huge panel.
    expect(scrcpyMaxSize(portrait, { maxWidth: 3840, maxHeight: 3840 })).toBe(2160);
    expect(scrcpyMaxSize({ width: 720, height: 1280 }, { maxWidth: 3840, maxHeight: 3840 })).toBe(
      0,
    );
  });
});
