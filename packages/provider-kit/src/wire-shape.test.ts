import { expect, test } from "vitest";
import { z } from "zod";
import { assertWireShape, WireShapeMismatch, wireShape } from "./wire-shape.ts";

const Request = z.object({ id: z.number(), query: z.object({ text: z.string() }) });

test("a worker whose channel schemas changed anywhere refuses the daemon's shape", () => {
  const daemon = wireShape([Request])();
  const changes = [
    // A nested field added.
    z.object({ id: z.number(), query: z.object({ text: z.string(), limit: z.number() }) }),
    // A default that the daemon's messages would not carry.
    z.object({ id: z.number(), query: z.object({ text: z.string().default("") }) }),
    // A field renamed.
    z.object({ id: z.number(), query: z.object({ words: z.string() }) }),
  ];
  for (const changed of changes)
    expect(() => assertWireShape("test", daemon, wireShape([changed]))).toThrow(WireShapeMismatch);
});

test("a worker of the same build accepts the daemon's shape", () => {
  const same = z.object({ id: z.number(), query: z.object({ text: z.string() }) });
  expect(() => assertWireShape("test", wireShape([Request])(), wireShape([same]))).not.toThrow();
});

test("a worker refuses a daemon that sent no shape", () => {
  expect(() => assertWireShape("test", undefined, wireShape([Request]))).toThrow(WireShapeMismatch);
});
