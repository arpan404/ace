import { describe, expect, it } from "vitest";
import {
  LockedUseFrameDecoder,
  decodeLockedUseMessage,
  encodeLockedUseFrame,
  encodeLockedUseRequest,
} from "./locked-use-wire.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (frame: Uint8Array) => new TextDecoder().decode(frame);
const header = (length: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(length, 0);
  return out;
};

const status = {
  phase: "ready",
  session: "locked",
  userID: 501,
  sessionID: 100003,
  attemptID: null,
  installation: {
    pluginSigned: true,
    ruleReachesMechanism: true,
    lockOnDisplaySleep: true,
    brokerLinked: true,
    guardianLinked: true,
    verified: true,
  },
};

describe("locked use frames", () => {
  it("a frame is a big-endian length then the payload, and decodes back to it", () => {
    const frame = encodeLockedUseFrame(bytes('{"a":1}'));
    expect([...frame.subarray(0, 4)]).toEqual([0, 0, 0, 7]);
    expect(new LockedUseFrameDecoder().push(frame).map(text)).toEqual(['{"a":1}']);
  });

  it("frames split across chunks and packed into one chunk all come out whole and in order", () => {
    const stream = Buffer.concat([
      encodeLockedUseFrame(bytes("first")),
      encodeLockedUseFrame(bytes("second")),
      encodeLockedUseFrame(bytes("x".repeat(65_536))),
    ]);
    const split = new LockedUseFrameDecoder();
    const out: string[] = [];
    for (let at = 0; at < stream.length; at += 3)
      out.push(...split.push(stream.subarray(at, at + 3)).map(text));
    expect(out.map((each) => each.slice(0, 6))).toEqual(["first", "second", "xxxxxx"]);
    expect(out[2]).toHaveLength(65_536);
    expect(new LockedUseFrameDecoder().push(stream)).toHaveLength(3);
  });

  it("a zero length poisons the stream: later bytes, even valid frames, are refused", () => {
    const decoder = new LockedUseFrameDecoder();
    expect(() => decoder.push(header(0))).toThrow();
    expect(() => decoder.push(encodeLockedUseFrame(bytes("ok")))).toThrow();
  });

  it("a length over 65,536 poisons the stream before any payload arrives", () => {
    const decoder = new LockedUseFrameDecoder();
    expect(decoder.push(encodeLockedUseFrame(bytes("before")))).toHaveLength(1);
    expect(() => decoder.push(header(65_537))).toThrow();
    expect(() => decoder.push(encodeLockedUseFrame(bytes("after")))).toThrow();
  });

  it("an empty or oversized payload is never sent", () => {
    expect(() => encodeLockedUseFrame(new Uint8Array())).toThrow();
    expect(() => encodeLockedUseFrame(new Uint8Array(65_537))).toThrow();
  });
});

describe("locked use requests", () => {
  it("begin carries the scope and agent processes under its id", () => {
    const scope = { userID: 501, sessionID: 7, threadID: "t", turnID: "r", attemptID: "a" };
    const [frame] = new LockedUseFrameDecoder().push(
      encodeLockedUseRequest("r1", { type: "begin", scope, agentProcessIDs: [42] }),
    );
    expect(JSON.parse(text(frame ?? new Uint8Array()))).toEqual({
      v: 1,
      id: "r1",
      type: "begin",
      scope,
      agentProcessIDs: [42],
    });
  });

  it("a request id outside 1 to 64 characters is refused", () => {
    expect(() => encodeLockedUseRequest("", { type: "status" })).toThrow();
    expect(() => encodeLockedUseRequest("x".repeat(65), { type: "status" })).toThrow();
  });
});

describe("locked use service messages", () => {
  const decode = (value: unknown) => decodeLockedUseMessage(bytes(JSON.stringify(value)));

  it("a state keeps fields this daemon doesn't know", () => {
    const message = decode({
      v: 1,
      type: "state",
      status: { ...status, later: "x", installation: { ...status.installation, extra: 1 } },
      note: "kept",
    });
    expect(message).toMatchObject({
      type: "state",
      note: "kept",
      status: { phase: "ready", later: "x", installation: { verified: true, extra: 1 } },
    });
  });

  it("replies, completions and errors are read with their fields", () => {
    expect(decode({ v: 1, type: "reply", id: "r1", ok: true, status })).toMatchObject({
      ok: true,
      status: { session: "locked" },
    });
    expect(
      decode({ type: "reply", id: "r2", ok: false, error: { code: "not_locked", message: "m" } }),
    ).toMatchObject({ ok: false, error: { code: "not_locked" } });
    expect(
      decode({
        v: 1,
        type: "completion",
        attemptID: "a",
        threadID: "t",
        turnID: "r",
        reason: "localInput",
        workError: null,
      }),
    ).toMatchObject({ type: "completion", reason: "localInput" });
    expect(
      decode({ v: 1, type: "error", code: "unlock_request_failed", message: "m", attemptID: "a" }),
    ).toMatchObject({ type: "error", code: "unlock_request_failed", attemptID: "a" });
  });

  it("an unknown message type or version is kept as unknown, not dropped as malformed", () => {
    expect(decode({ v: 1, type: "telemetry", x: 1 })).toEqual({
      type: "unknown",
      raw: { v: 1, type: "telemetry", x: 1 },
    });
    expect(decode({ v: 2, type: "state", status })).toMatchObject({ type: "unknown" });
  });

  it("malformed messages are rejected", () => {
    expect(decodeLockedUseMessage(bytes("not json"))).toBeUndefined();
    expect(decodeLockedUseMessage(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(decode([1, 2])).toBeUndefined();
    expect(
      decode({ v: 1, type: "state", status: { ...status, phase: "dancing" } }),
    ).toBeUndefined();
    expect(decode({ v: 1, type: "state", status: { ...status, userID: -1 } })).toBeUndefined();
    expect(decode({ v: 1, type: "reply", ok: true })).toBeUndefined();
    expect(decode({ v: 1, type: "completion", attemptID: "a" })).toBeUndefined();
  });
});
