/*
 * A stand-in for Swift's native host in bridge tests: it decodes every frame the pump emits and
 * acknowledges it, and answers host calls from `calls`. Imported before any bridge module, since
 * they read `globalThis.aceHost` when they load. Test-only.
 */
import { nodeInflate } from "./test-inflate.ts";

type Call = (input: unknown) => Promise<string>;

export const native = {
  frames: [] as Record<string, unknown>[],
  ack: (_accepted: boolean) => {},
  calls: new Map<string, Call>(),
};
let next = 0;

Object.assign(globalThis, {
  aceHost: {
    call(operation: string, input: string, done: (error: string | null, value: string) => void) {
      const handler = native.calls.get(operation);
      if (!handler) return;
      handler(JSON.parse(input)).then(
        (value) => done(null, value),
        (error: unknown) => done(error instanceof Error ? error.message : "failed", ""),
      );
    },
    emit(frame: string) {
      native.frames.push(...(JSON.parse(frame) as Record<string, unknown>[]));
      setTimeout(() => native.ack(true), 0);
    },
    socket: () => {},
    timer: (_id: string, delay: number, callback: () => void) => setTimeout(callback, delay),
    cancelTimer: () => {},
    now: () => Date.now(),
    uuid: () => `id-${++next}`,
    random: () => 0.5,
    utf8Base64: (text: string) => Buffer.from(text, "utf8").toString("base64"),
    previewHead: (text: string, limit: number) => text.slice(0, limit),
    previewTail: (text: string, limit: number) => text.slice(-limit),
    encode: (text: string) => new TextEncoder().encode(text),
    decode: (bytes: Uint8Array, encoding: string, fatal: boolean) =>
      new TextDecoder(encoding, { fatal }).decode(bytes),
    inflate: nodeInflate,
    randomBytes: (count: number) => Array.from({ length: count }, () => 7),
    base64: (text: string, decode: boolean) =>
      decode
        ? Buffer.from(text, "base64").toString("binary")
        : Buffer.from(text, "binary").toString("base64"),
  },
});
