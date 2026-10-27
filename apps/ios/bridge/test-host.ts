/*
 * The Node implementation of the host contract (`@ace/native-host/node`) standing in for Swift
 * in bridge tests. It records every patch the pump emits, reassembling oversized ones from their
 * fragments as Swift does, acknowledges each frame on the next tick, and answers async
 * operations from `native.calls`. Import it before any bridge module: they connect to
 * `globalThis.aceHost` as they load. Test-only.
 */
import { createNodeHost, type NodeOperation } from "@ace/native-host/node";

export const native = {
  frames: [] as Record<string, unknown>[],
  ack: (_accepted: boolean) => {},
  calls: new Map<string, NodeOperation>(),
  /** What the bridge asks of its native socket: open, send or close. */
  socket: (_id: string, _action: string, _value: string) => {},
};
let fragments = "";

export const host = createNodeHost({
  operations: native.calls,
  randomBytes: (count) => new Uint8Array(count).fill(7),
  socket: (id, action, value) => native.socket(id, action, value),
  emit(frame) {
    for (const patch of JSON.parse(frame) as Record<string, unknown>[]) {
      if (patch.type !== "fragment") {
        native.frames.push(patch);
        continue;
      }
      fragments += String(patch.data);
      if (patch.last !== true) continue;
      native.frames.push(JSON.parse(Buffer.from(fragments, "base64").toString("utf8")));
      fragments = "";
    }
    setTimeout(() => native.ack(true), 0);
  },
});
Object.assign(globalThis, { aceHost: host });

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
