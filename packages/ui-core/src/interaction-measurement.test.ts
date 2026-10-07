import type { InteractionMeasurement } from "@ace/protocol";
import { expect, test } from "vitest";
import { readMeasurement } from "./interaction-measurement.ts";

const measurement: InteractionMeasurement = {
  source: "screen-frames",
  target: { kind: "window", bundleId: "com.apple.Safari", windowId: 4 },
  refreshHz: 120,
  windowMs: 2000,
  frames: 80,
  hitches: [],
  verdict: "smooth",
  confidence: "high",
  notes: [],
};
const jpeg = "/9j/4AAQSkZJRgABAQ==";

test("a Codex MCP result yields the measurement and its filmstrip", () => {
  const result = readMeasurement({
    raw: [
      {
        type: "mcpToolCall",
        data: {
          tool: "screen_measure_interaction",
          arguments: { observeMs: 2000 },
          result: {
            content: [
              { type: "text", text: JSON.stringify(measurement) },
              { type: "image", mimeType: "image/jpeg", data: jpeg },
            ],
          },
        },
      },
    ],
  });
  expect(result?.measurement.verdict).toBe("smooth");
  expect(result?.filmstrip).toBe(`data:image/jpeg;base64,${jpeg}`);
});

test("a Claude tool result with an Anthropic image source yields the same", () => {
  const result = readMeasurement({
    raw: [
      {
        type: "user",
        data: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  { type: "text", text: JSON.stringify({ ...measurement, verdict: "janky" }) },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/jpeg", data: jpeg },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  });
  expect(result?.measurement.verdict).toBe("janky");
  expect(result?.filmstrip).toBe(`data:image/jpeg;base64,${jpeg}`);
});

test("a result without a filmstrip, given as a bare string, still reads", () => {
  const result = readMeasurement({
    raw: [{ type: "user", data: { content: JSON.stringify(measurement) } }],
  });
  expect(result?.measurement.target).toEqual(measurement.target);
  expect(result?.filmstrip).toBeUndefined();
});

test("nothing reads from other text, a malformed result or a payload kept only as a blob", () => {
  const other = { type: "text", text: JSON.stringify({ verdict: "smooth", note: "not ours" }) };
  expect(readMeasurement({ raw: [{ type: "mcpToolCall", data: { content: [other] } }] })).toBe(
    undefined,
  );
  expect(
    readMeasurement({ raw: [{ type: "mcpToolCall", data: { content: '{"verdict": "smo' } }] }),
  ).toBe(undefined);
  expect(
    readMeasurement({
      raw: [{ type: "mcpToolCall", blobRef: "blob-1", size: 90_000, preview: '{"verdict"' }],
    }),
  ).toBe(undefined);
});

test("typed daemon evidence wins over provider payloads and carries an authenticated attachment reference", () => {
  const filmstrip = {
    sha256: "a".repeat(64),
    bytes: 60000,
    mimeType: "image/jpeg",
    name: "filmstrip.jpg",
  };
  const result = readMeasurement(
    { raw: [{ type: "mcpToolCall", data: JSON.stringify(measurement) }] },
    { ...measurement, verdict: "janky", filmstrip },
  );
  expect(result?.measurement.verdict).toBe("janky");
  expect(result?.filmstripAttachment).toEqual(filmstrip);
  expect(result?.filmstrip).toBeUndefined();
});
test("typed evidence remains readable with only a provider blob reference or a standalone annotation", () => {
  const { filmstrip: _inline, ...typed } = measurement;
  expect(
    readMeasurement(
      { raw: [{ type: "mcpToolCall", blobRef: "oversize", size: 90000, preview: "" }] },
      typed,
    )?.measurement,
  ).toEqual(measurement);
  expect(readMeasurement(undefined, typed)?.measurement).toEqual(measurement);
});
