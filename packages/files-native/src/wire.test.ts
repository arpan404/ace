import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { messageSchema } from "./schemas.ts";
import {
  FrameDecoder,
  MAX_BODY_LEN,
  MAX_FRAME_LEN,
  encodeBody,
  encodeMessage,
  FilesWireError,
} from "./wire.ts";

const vectors = fileURLToPath(new URL("../../../native/files/vectors/", import.meta.url));

const messageVector = z.object({
  json: z.unknown(),
  text: z.string(),
  frame: z.string(),
});
const bodyVector = z.object({
  json: z.object({ id: z.number().int(), bytes: z.string() }),
  frame: z.string(),
});
const vector = z.union([messageVector, bodyVector]);

function hex(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function frameOfPayload(kind: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(4 + 1 + payload.length);
  new DataView(bytes.buffer).setUint32(0, 1 + payload.length, true);
  bytes[4] = kind;
  bytes.set(payload, 5);
  return bytes;
}

function failureOf(fn: () => unknown): FilesWireError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FilesWireError) return error;
    throw error;
  }
  throw new Error("expected a FilesWireError");
}

function decodeAll(bytes: Uint8Array): ReturnType<FrameDecoder["poll"]>[] {
  const decoder = new FrameDecoder();
  decoder.push(bytes);
  const frames: ReturnType<FrameDecoder["poll"]>[] = [];
  for (;;) {
    const frame = decoder.poll();
    if (!frame) break;
    frames.push(frame);
  }
  return frames;
}

describe("the files wire", () => {
  it("every golden vector round-trips byte for byte", () => {
    const files = readdirSync(vectors)
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parsed = vector.parse(JSON.parse(readFileSync(vectors + file, "utf8")));
      const frame = hex(parsed.frame);
      if ("text" in parsed) {
        const message = messageSchema.parse(JSON.parse(parsed.text));
        expect(JSON.stringify(message), file).toBe(parsed.text);
        expect(toHex(encodeMessage(message)), file).toBe(parsed.frame);
        const frames = decodeAll(frame);
        expect(frames, file).toHaveLength(1);
        const decoded = frames[0];
        expect(decoded?.kind, file).toBe("message");
        if (decoded?.kind === "message") {
          expect(decoded.text, file).toBe(parsed.text);
          expect(decoded.message, file).toEqual(message);
        }
      } else {
        const bytes = hex(parsed.json.bytes);
        expect(toHex(encodeBody(parsed.json.id, bytes)), file).toBe(parsed.frame);
        const frames = decodeAll(frame);
        expect(frames, file).toHaveLength(1);
        const decoded = frames[0];
        expect(decoded?.kind, file).toBe("body");
        if (decoded?.kind === "body") {
          expect(decoded.id, file).toBe(parsed.json.id);
          expect(toHex(decoded.bytes), file).toBe(parsed.json.bytes);
        }
      }
    }
  });

  it("decoder_handles_split_and_joined_frames", () => {
    const one = encodeMessage({
      type: "request",
      id: 1,
      op: { op: "stat", root: 1, path: "src/lib.rs" },
    });
    const two = encodeMessage({ type: "cancel", id: 1 });
    for (let cut = 0; cut <= one.length; cut++) {
      const decoder = new FrameDecoder();
      decoder.push(one.subarray(0, cut));
      decoder.push(one.subarray(cut));
      expect([decoder.poll()?.kind, decoder.poll()?.kind], `cut ${cut}`).toEqual([
        "message",
        undefined,
      ]);
    }
    const joined = new FrameDecoder();
    joined.push(Uint8Array.from([...one, ...two]));
    const firstFrame = joined.poll();
    const secondFrame = joined.poll();
    expect([firstFrame?.kind, secondFrame?.kind, joined.poll()?.kind]).toEqual([
      "message",
      "message",
      undefined,
    ]);
    expect(secondFrame?.kind === "message" ? secondFrame.message.type : undefined).toBe("cancel");
  });

  it("decoder_rejects_oversize_frame_and_stays_dead", () => {
    const decoder = new FrameDecoder();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_LEN + 1, true);
    decoder.push(header);
    expect(failureOf(() => decoder.poll()).code).toBe("TOO_LARGE");
    decoder.push(new Uint8Array(1024).fill(7));
    expect(decoder.bufferedBytes()).toBe(0);
    expect(failureOf(() => decoder.poll()).code).toBe("TOO_LARGE");
  });

  it("decoder_survives_a_broken_message_and_knows_its_id", () => {
    const decoder = new FrameDecoder();
    const broken = frameOfPayload(
      1,
      new TextEncoder().encode('{"type":"response","id":42,"result":{"type":"unknown"}}'),
    );
    decoder.push(broken);
    decoder.push(encodeMessage({ type: "cancel", id: 1 }));
    expect(failureOf(() => decoder.poll())).toMatchObject({ code: "INVALID_ARGUMENT", id: 42 });
    const next = decoder.poll();
    expect(next?.kind === "message" ? next.message.type : undefined).toBe("cancel");
    expect(decoder.poll()).toBeUndefined();
  });

  it("decoder_reports_an_unknown_kind_and_continues", () => {
    const decoder = new FrameDecoder();
    decoder.push(frameOfPayload(9, new TextEncoder().encode("nonsense")));
    decoder.push(encodeMessage({ type: "cancel", id: 3 }));
    expect(failureOf(() => decoder.poll()).code).toBe("UNSUPPORTED");
    const next = decoder.poll();
    expect(next?.kind === "message" ? next.message.type : undefined).toBe("cancel");
  });

  it("ignores_unknown_fields_in_a_message", () => {
    const text = '{"type":"cancel","id":9,"newField":{"kept":false}}';
    const decoder = new FrameDecoder();
    decoder.push(frameOfPayload(1, new TextEncoder().encode(text)));
    const frame = decoder.poll();
    expect(frame?.kind === "message" ? frame.message : undefined).toEqual({
      type: "cancel",
      id: 9,
    });
  });

  it("decoder_rejects_invalid_utf8_in_a_message", () => {
    const decoder = new FrameDecoder();
    decoder.push(frameOfPayload(1, Uint8Array.of(0xff, 0xfe, 0x7b)));
    expect(failureOf(() => decoder.poll()).code).toBe("INVALID_ARGUMENT");
  });

  it("decoder_rejects_ids_outside_the_safe_integer_range", () => {
    const unsafe = frameOfPayload(
      1,
      new TextEncoder().encode('{"type":"cancel","id":9007199254740992}'),
    );
    const decoder = new FrameDecoder();
    decoder.push(unsafe);
    expect(failureOf(() => decoder.poll()).code).toBe("INVALID_ARGUMENT");

    const broken = frameOfPayload(
      1,
      new TextEncoder().encode(
        '{"type":"response","id":9007199254740992,"result":{"type":"bogus"}}',
      ),
    );
    const second = new FrameDecoder();
    second.push(broken);
    expect(failureOf(() => second.poll()).id).toBeUndefined();
  });

  it("decoder_rejects_an_empty_frame_and_a_truncated_body", () => {
    const empty = new FrameDecoder();
    empty.push(new Uint8Array(4));
    expect(failureOf(() => empty.poll()).code).toBe("INVALID_ARGUMENT");
    const truncated = new FrameDecoder();
    truncated.push(frameOfPayload(2, new Uint8Array(3)));
    expect(failureOf(() => truncated.poll()).code).toBe("INVALID_ARGUMENT");
  });

  it("encoder_refuses_a_body_over_the_limit", () => {
    expect(() => encodeBody(1, new Uint8Array(MAX_BODY_LEN))).not.toThrow();
    expect(() => encodeBody(1, new Uint8Array(MAX_BODY_LEN + 1))).toThrowError(
      /16 MiB frame limit/,
    );
  });
});
