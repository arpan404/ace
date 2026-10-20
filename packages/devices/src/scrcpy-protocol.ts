/**
 * ace's own client side of the scrcpy wire protocol, written from scrcpy's `doc/develop.md` and
 * the message layouts its protocol tests document. There is no backward compatibility between
 * scrcpy versions, so every byte layout here belongs to the pinned server in `scrcpy-server.ts`.
 * Pure: no sockets, no clocks.
 */

/** Android `MotionEvent` actions the server accepts per pointer; it derives POINTER_DOWN/UP. */
export const touchAction = { down: 0, up: 1, move: 2, cancel: 3 } as const;
/** Android `KeyEvent` actions. */
export const keyAction = { down: 0, up: 1 } as const;
/** Android `KeyEvent` codes ace sends. */
export const keycode = {
  home: 3,
  back: 4,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  enter: 66,
  appSwitch: 187,
  k: 39,
  altLeft: 57,
} as const;
/** `KeyEvent` meta state with the left Alt key held: META_ALT_ON | META_ALT_LEFT_ON. */
export const altOn = 0x12;

const type = {
  keycode: 0,
  text: 1,
  touch: 2,
  scroll: 3,
  backOrScreenOn: 4,
  getClipboard: 8,
  setClipboard: 9,
  rotate: 11,
  resetVideo: 17,
} as const;

/** The server refuses longer injected text; longer strings are split by the caller. */
export const injectTextLimit = 300;
/** The server's control message cap is 256 KiB; a clipboard message carries 14 header bytes. */
export const clipboardTextLimit = (1 << 18) - 14;

export type ScreenSize = { width: number; height: number };
export type ControlMessage =
  | { type: "keycode"; action: "down" | "up"; keycode: number; repeat?: number; meta?: number }
  | { type: "text"; text: string }
  | {
      type: "touch";
      action: keyof typeof touchAction;
      pointerId: bigint;
      x: number;
      y: number;
      screen: ScreenSize;
      pressure: number;
    }
  | { type: "scroll"; x: number; y: number; screen: ScreenSize; dx: number; dy: number }
  | { type: "backOrScreenOn"; action: "down" | "up" }
  | { type: "getClipboard" }
  | { type: "setClipboard"; sequence: bigint; text: string; paste: boolean }
  | { type: "rotate" }
  | { type: "resetVideo" };

function utf8(text: string, limit: number): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > limit) throw new RangeError("scrcpy text exceeds the server's limit");
  return bytes;
}
function clampInt(value: number): number {
  return Math.max(0, Math.min(0x7fffffff, Math.round(value)));
}
function u16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}
/** Pressure is an unsigned 16-bit fixed-point fraction where 0xffff is exactly 1.0. */
function pressure(value: number): number {
  return value >= 1 ? 0xffff : u16(Math.max(0, value) * 0x10000);
}
/** Scroll amounts are signed 16-bit fixed point over [-16, 16]. */
function scrollAmount(value: number): number {
  const scaled = Math.round((Math.max(-16, Math.min(16, value)) / 16) * 0x8000);
  return Math.max(-0x8000, Math.min(0x7fff, scaled));
}
function position(buffer: Buffer, offset: number, x: number, y: number, screen: ScreenSize) {
  buffer.writeInt32BE(clampInt(x), offset);
  buffer.writeInt32BE(clampInt(y), offset + 4);
  buffer.writeUInt16BE(u16(screen.width), offset + 8);
  buffer.writeUInt16BE(u16(screen.height), offset + 10);
}

export function encodeControl(message: ControlMessage): Buffer {
  switch (message.type) {
    case "keycode": {
      const buffer = Buffer.alloc(14);
      buffer.writeUInt8(type.keycode, 0);
      buffer.writeUInt8(keyAction[message.action], 1);
      buffer.writeInt32BE(message.keycode, 2);
      buffer.writeInt32BE(message.repeat ?? 0, 6);
      buffer.writeInt32BE(message.meta ?? 0, 10);
      return buffer;
    }
    case "text": {
      const text = utf8(message.text, injectTextLimit);
      const head = Buffer.alloc(5);
      head.writeUInt8(type.text, 0);
      head.writeUInt32BE(text.length, 1);
      return Buffer.concat([head, text]);
    }
    case "touch": {
      const buffer = Buffer.alloc(32);
      buffer.writeUInt8(type.touch, 0);
      buffer.writeUInt8(touchAction[message.action], 1);
      buffer.writeBigInt64BE(message.pointerId, 2);
      position(buffer, 10, message.x, message.y, message.screen);
      buffer.writeUInt16BE(pressure(message.pressure), 22);
      // A finger has no mouse buttons: action button and button state are both zero.
      buffer.writeInt32BE(0, 24);
      buffer.writeInt32BE(0, 28);
      return buffer;
    }
    case "scroll": {
      const buffer = Buffer.alloc(21);
      buffer.writeUInt8(type.scroll, 0);
      position(buffer, 1, message.x, message.y, message.screen);
      buffer.writeInt16BE(scrollAmount(message.dx), 13);
      buffer.writeInt16BE(scrollAmount(message.dy), 15);
      buffer.writeInt32BE(0, 17);
      return buffer;
    }
    case "backOrScreenOn":
      return Buffer.from([type.backOrScreenOn, keyAction[message.action]]);
    case "getClipboard":
      // Copy key "none": read the clipboard without pressing copy or cut first.
      return Buffer.from([type.getClipboard, 0]);
    case "setClipboard": {
      const text = utf8(message.text, clipboardTextLimit);
      const head = Buffer.alloc(14);
      head.writeUInt8(type.setClipboard, 0);
      head.writeBigInt64BE(message.sequence, 1);
      head.writeUInt8(message.paste ? 1 : 0, 9);
      head.writeUInt32BE(text.length, 10);
      return Buffer.concat([head, text]);
    }
    case "rotate":
      return Buffer.from([type.rotate]);
    case "resetVideo":
      return Buffer.from([type.resetVideo]);
  }
}

export type DeviceMessage =
  | { type: "clipboard"; text: string }
  | { type: "clipboardAck"; sequence: bigint }
  | { type: "uhidOutput"; id: number; bytes: number }
  | { type: "unknown"; code: number };

/**
 * Splits the server's device-to-client control stream into messages. An unknown message type has
 * no length we can trust, so it ends parsing: the caller reports it and stops reading.
 */
export class DeviceMessageReader {
  private buffer: Buffer = Buffer.alloc(0);
  private broken = false;
  private readonly emit: (message: DeviceMessage) => void;
  constructor(emit: (message: DeviceMessage) => void) {
    this.emit = emit;
  }
  push(chunk: Buffer): void {
    if (this.broken) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > clipboardTextLimit + 64)
      throw new Error("scrcpy device message exceeds limit");
    for (;;) {
      const consumed = this.next();
      if (!consumed) return;
      this.buffer = this.buffer.subarray(consumed);
    }
  }
  private next(): number {
    const buffer = this.buffer;
    if (!buffer.length) return 0;
    const code = buffer.readUInt8(0);
    if (code === 0) {
      if (buffer.length < 5) return 0;
      const length = buffer.readUInt32BE(1);
      if (length > clipboardTextLimit) throw new Error("scrcpy clipboard exceeds limit");
      if (buffer.length < 5 + length) return 0;
      this.emit({ type: "clipboard", text: buffer.subarray(5, 5 + length).toString("utf8") });
      return 5 + length;
    }
    if (code === 1) {
      if (buffer.length < 9) return 0;
      this.emit({ type: "clipboardAck", sequence: buffer.readBigUInt64BE(1) });
      return 9;
    }
    if (code === 2) {
      if (buffer.length < 5) return 0;
      const length = buffer.readUInt16BE(3);
      if (buffer.length < 5 + length) return 0;
      this.emit({ type: "uhidOutput", id: buffer.readUInt16BE(1), bytes: length });
      return 5 + length;
    }
    this.broken = true;
    this.emit({ type: "unknown", code });
    return 0;
  }
}

export const videoCodecId = { h264: 0x68323634, h265: 0x68323635, av1: 0x00617631 } as const;

export type VideoEvent =
  | { type: "codec"; id: number }
  | { type: "session"; width: number; height: number }
  | { type: "packet"; config: boolean; keyframe: boolean; pts: bigint; payload: Buffer };

/**
 * Reads the video socket after the connection preamble: a u32 codec id, then 12-byte session
 * packets (MSB set, then width and height) and media packets (flags and PTS in a u64, then a u32
 * size and that many bytes of the encoder's output).
 */
export class VideoStreamReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private codec = false;
  private readonly emit: (event: VideoEvent) => void;
  private readonly maxPacket: number;
  constructor(emit: (event: VideoEvent) => void, maxPacket = 8 * 1024 * 1024) {
    this.emit = emit;
    this.maxPacket = maxPacket;
  }
  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    for (;;) {
      if (!this.codec) {
        if (this.length < 4) return;
        this.codec = true;
        this.emit({ type: "codec", id: this.take(4).readUInt32BE(0) });
        continue;
      }
      if (this.length < 12) return;
      const head = this.peek(12);
      const first = head.readUInt8(0);
      if (first & 0x80) {
        this.take(12);
        this.emit({ type: "session", width: head.readUInt32BE(4), height: head.readUInt32BE(8) });
        continue;
      }
      const size = head.readUInt32BE(8);
      if (size > this.maxPacket) throw new Error("scrcpy video packet exceeds limit");
      if (this.length < 12 + size) return;
      this.take(12);
      const word = head.readBigUInt64BE(0);
      const payload = this.take(size);
      this.emit({
        type: "packet",
        config: (first & 0x40) !== 0,
        keyframe: (first & 0x20) !== 0,
        pts: word & ((1n << 61n) - 1n),
        payload,
      });
    }
  }
  private peek(count: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= count) return first.subarray(0, count);
    const joined = Buffer.concat(this.chunks, this.length);
    this.chunks = [joined];
    return joined.subarray(0, count);
  }
  /** Removes `count` bytes. A packet inside one socket chunk is a view, not a copy. */
  private take(count: number): Buffer {
    const out = this.peek(count);
    const first = this.chunks[0];
    if (!first) return out;
    const rest = first.subarray(count);
    if (rest.length) this.chunks[0] = rest;
    else this.chunks.shift();
    this.length -= count;
    return out;
  }
}

/** The 31-bit session id names the device's abstract socket, so concurrent servers never meet. */
export function scrcpySocketName(scid: number): string {
  return `scrcpy_${scid.toString(16).padStart(8, "0")}`;
}

export type ServerProfile = {
  scid: number;
  maxSize: number;
  bitrate: number;
  fps: number;
};
/** Server arguments after the class name: video on, audio off, control on, forward tunnel. */
export function scrcpyServerArgs(version: string, profile: ServerProfile): string[] {
  return [
    version,
    `scid=${profile.scid.toString(16).padStart(8, "0")}`,
    "log_level=warn",
    "video=true",
    "audio=false",
    "control=true",
    "tunnel_forward=true",
    "video_codec=h264",
    `max_size=${Math.max(0, Math.floor(profile.maxSize))}`,
    `video_bit_rate=${Math.max(1, Math.floor(profile.bitrate))}`,
    `max_fps=${Math.max(1, Math.floor(profile.fps))}`,
    // Device clipboard changes would otherwise be pushed to the daemon, which never uses them.
    "clipboard_autosync=false",
    "cleanup=true",
    "power_on=false",
    "stay_awake=false",
    "show_touches=false",
  ];
}

/**
 * Device H.264 encoders commonly refuse an edge much past 2160 (an emulator's did in landscape),
 * and the server only shrinks after a failed start; keep the longer edge there in either
 * orientation.
 */
const longestFrameEdge = 2160;
/**
 * The server's `max_size` bounds the longer edge. Fit the display inside the viewer's box, keep
 * the aspect ratio, never upscale, and stay within what encoders accept in either orientation.
 */
export function scrcpyMaxSize(
  display: ScreenSize,
  box: { maxWidth: number; maxHeight: number },
): number {
  const factor = Math.min(1, box.maxWidth / display.width, box.maxHeight / display.height);
  const longest = Math.max(display.width, display.height);
  const fitted = Math.min(longest * factor, longestFrameEdge);
  return fitted >= longest ? 0 : Math.max(16, Math.floor(fitted / 8) * 8);
}
