import { host } from "./host.ts";

// Only the portable SDK's required Web APIs. Encoding and entropy belong to the native host.
class UTF8Encoder {
  encode(text = ""): Uint8Array {
    return Uint8Array.from(host.encode(text));
  }
  encodeInto(text: string, destination: Uint8Array): { read: number; written: number } {
    let read = 0;
    let written = 0;
    for (const character of text) {
      const bytes = this.encode(character);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      read += character.length;
      written += bytes.length;
    }
    return { read, written };
  }
}
class UTF8Decoder {
  readonly encoding: string;
  readonly options: { fatal?: boolean };
  constructor(encoding = "utf-8", options: { fatal?: boolean } = {}) {
    this.encoding = encoding;
    this.options = options;
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return "";
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return host.decode(Array.from(bytes), this.encoding, this.options.fatal ?? false);
  }
}
class CancellationSignal {
  aborted = false;
  reason: unknown;
  readonly listeners = new Set<() => void>();
  addEventListener(_type: string, callback: () => void): void {
    this.listeners.add(callback);
  }
  removeEventListener(_type: string, callback: () => void): void {
    this.listeners.delete(callback);
  }
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }
  abort(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}
class CancellationController {
  readonly signal = new CancellationSignal();
  abort(reason: unknown = new Error("Aborted")): void {
    this.signal.abort(reason);
  }
}
Object.assign(globalThis, {
  TextEncoder: UTF8Encoder,
  TextDecoder: UTF8Decoder,
  AbortController: CancellationController,
  queueMicrotask: (callback: () => void) => {
    void Promise.resolve().then(callback);
  },
  btoa: (value: string) => host.base64(value, false),
  atob: (value: string) => host.base64(value, true),
  crypto: {
    randomUUID: () => host.uuid(),
    getRandomValues: <T extends Uint8Array>(array: T): T => {
      if (array.byteLength > 65536) throw new Error("Entropy request exceeds 64 KiB");
      array.set(host.randomBytes(array.length));
      return array;
    },
  },
});

export { host };
