import { closeSync, fstatSync } from "node:fs";
import { expect, test } from "vitest";
import { pipeDescriptors } from "./descriptor.ts";

interface Sink {
  write(chunk: Uint8Array): number | Promise<number>;
  end(): number | Promise<number>;
}
const bun: unknown = Reflect.get(globalThis, "Bun");
function isSink(value: unknown): value is Sink {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "write") === "function" &&
    typeof Reflect.get(value, "end") === "function"
  );
}
function writer(fd: number): Sink | undefined {
  if (typeof bun !== "object" || bun === null) return undefined;
  const file: unknown = Reflect.get(bun, "file");
  if (typeof file !== "function") return undefined;
  const made: unknown = Reflect.apply(file, bun, [fd]);
  const create: unknown = typeof made === "object" && made ? Reflect.get(made, "writer") : undefined;
  if (typeof create !== "function") return undefined;
  const sink: unknown = Reflect.apply(create, made, []);
  return isSink(sink) ? sink : undefined;
}

// The input pipe closes its write end itself after ending Bun's FileSink. If a Bun release made
// the sink close a descriptor it was given, that second close could hit a reused descriptor
// (a database or socket), so this fails first. FileSink exists only on Bun.
test.skipIf(typeof bun !== "object")(
  "Bun's file sink leaves the pipe descriptor it was given open after ending",
  async () => {
    const pair = pipeDescriptors();
    try {
      const sink = writer(pair.write);
      if (!sink) throw new Error("Bun.file(fd).writer() is unavailable");
      await sink.write(Buffer.from("x"));
      await sink.end();
      expect(fstatSync(pair.write).isFIFO()).toBe(true);
    } finally {
      closeSync(pair.write);
      closeSync(pair.read);
    }
  },
);
