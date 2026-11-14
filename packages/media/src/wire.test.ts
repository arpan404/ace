import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  ToMedia,
  FromMedia,
  controlLane,
  encodeControl,
  decodeToMedia,
  decodeFromMedia,
} from "@ace/media/wire";
const directory = new URL("../../../native/media/vectors/control/", import.meta.url);
const Fixture = z.strictObject({
  direction: z.enum(["ToMedia", "FromMedia"]),
  message: z.record(z.string(), z.unknown()),
});
test("every control variant has a shared fixture and survives its binary lane", () => {
  const seen = { ToMedia: new Set<string>(), FromMedia: new Set<string>() };
  for (const name of readdirSync(directory)) {
    const fixture = Fixture.parse(JSON.parse(readFileSync(new URL(name, directory), "utf8")));
    const message =
      fixture.direction === "ToMedia"
        ? ToMedia.parse(fixture.message)
        : FromMedia.parse(fixture.message);
    expect(message).toEqual(fixture.message);
    seen[fixture.direction].add(message.type);
    const schema = fixture.direction === "ToMedia" ? ToMedia : FromMedia;
    expect(schema.safeParse({ ...message, unknown: true }).success).toBe(false);
    const payload = new Uint8Array(
      ["init", "source.open", "media.ticket"].includes(message.type)
        ? 32
        : message.type === "relay.keys"
          ? 120
          : message.type === "listen" && message.remote
            ? message.remote.certificateBytes + message.remote.keyBytes
            : 0,
    );
    const lane = controlLane(message.type),
      parts = encodeControl(message, payload, lane);
    const bytes = new Uint8Array(parts.header.length + payload.length);
    bytes.set(parts.header);
    bytes.set(payload, parts.header.length);
    const decode = fixture.direction === "ToMedia" ? decodeToMedia : decodeFromMedia;
    expect(decode(bytes, lane)).toEqual({ message, payload });
    expect(() => decode(bytes, lane === "normal" ? "priority" : "normal")).toThrow();
    expect(() => decode(bytes.subarray(0, bytes.length - 1), lane)).toThrow();
  }
  expect(seen.ToMedia).toEqual(new Set(ToMedia.options.map((option) => option.shape.type.value)));
  expect(seen.FromMedia).toEqual(
    new Set(FromMedia.options.map((option) => option.shape.type.value)),
  );
});
test("control boundaries reject malformed grants while opaque metadata retains unknown fields", () => {
  const metadata = {
    type: "record.meta",
    recording: "r",
    epoch: 3,
    data: { future: { nested: 12 } },
  };
  expect(ToMedia.parse(metadata)).toEqual(metadata);
  expect(ToMedia.safeParse({ type: "ping", id: "x".repeat(65) }).success).toBe(false);
  expect(
    ToMedia.safeParse({ type: "source.epoch", source: "s", seq: 2 ** 53, epoch: 1 }).success,
  ).toBe(false);
  expect(
    ToMedia.safeParse({
      type: "record.epochs",
      source: "s",
      seq: 0,
      decided: 4,
      clear: [[4, 2]],
      discard: [],
    }).success,
  ).toBe(false);
  expect(ToMedia.safeParse({ type: "unknown" }).success).toBe(false);
});
test("control framing rejects oversized lengths, invalid UTF-8 and misplaced secrets", () => {
  const message: ToMedia = { type: "ping", id: "p" };
  expect(() => encodeControl(message, new Uint8Array(32), "normal")).toThrow();
  const parts = encodeControl(message, new Uint8Array(), "normal");
  for (const length of [0, 3, 8 * 1024 * 1024 + 1]) {
    const bad = parts.header.slice();
    new DataView(bad.buffer).setUint32(0, length);
    expect(() => decodeToMedia(bad, "normal")).toThrow();
  }
  const bad = parts.header.slice();
  bad[8] = 255;
  expect(() => decodeToMedia(bad, "normal")).toThrow();
});

const BoundaryCases = z
  .array(
    z.strictObject({
      name: z.string(),
      direction: z.enum(["ToMedia", "FromMedia"]),
      accept: z.boolean(),
      json: z.string(),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../native/media/vectors/control-boundary/cases.json", import.meta.url),
        "utf8",
      ),
    ),
  );
test.each(BoundaryCases)("shared control boundary: $name", ({ direction, accept, json }) => {
  const schema = direction === "ToMedia" ? ToMedia : FromMedia;
  const input: unknown = JSON.parse(json);
  const parsed = schema.safeParse(input);
  expect(parsed.success).toBe(accept);
  if (parsed.success) expect(parsed.data).toEqual(input);
});
