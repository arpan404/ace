/*
 * A stand-in for Swift's native host in bridge tests: it records every patch frame and
 * acknowledges it on the next tick. Import it before any bridge module, which reads
 * `globalThis.aceHost` as it loads.
 */
export const native = { frames: [] as Record<string, unknown>[], ack: (_accepted: boolean) => {} };
let next = 0;
let fragments = "";
Object.assign(globalThis, {
  aceHost: {
    call: () => {},
    emit(frame: string) {
      for (const patch of JSON.parse(frame) as Record<string, unknown>[]) {
        if (patch.type !== "fragment") {
          native.frames.push(patch);
          continue;
        }
        // Oversized patches arrive as base64 fragments; Swift reassembles them the same way.
        fragments += String(patch.data);
        if (patch.last !== true) continue;
        native.frames.push(JSON.parse(Buffer.from(fragments, "base64").toString("utf8")));
        fragments = "";
      }
      setTimeout(() => native.ack(true), 0);
    },
    socket: () => {},
    timer: (_id: string, delay: number, callback: () => void) => setTimeout(callback, delay),
    cancelTimer: () => {},
    now: () => Date.now(),
    uuid: () => `id-${++next}`,
    random: () => 0.5,
    encode: (text: string) => [...new TextEncoder().encode(text)],
    utf8Base64: (text: string) => Buffer.from(text, "utf8").toString("base64"),
    previewHead: (text: string, limit: number) => text.slice(0, limit),
    previewTail: (text: string, limit: number) => text.slice(-limit),
    decode: (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes)),
    randomBytes: (count: number) => Array.from({ length: count }, () => 7),
    base64: (text: string, decode: boolean) =>
      decode
        ? Buffer.from(text, "base64").toString("binary")
        : Buffer.from(text, "binary").toString("base64"),
  },
});

/** The latest delivered patch of a type (and id, when given), as Swift would hold it. */
export function latest(type: string, id?: string): Record<string, unknown> | undefined {
  for (let index = native.frames.length - 1; index >= 0; index--) {
    const frame = native.frames[index];
    if (frame?.type === type && (id === undefined || frame.id === id)) return frame;
  }
  return undefined;
}

/** Wait until `check` holds, failing after two seconds. */
export async function until<T>(check: () => T | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the bridge");
}
