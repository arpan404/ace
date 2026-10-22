import { z } from "zod";
import { installDecompression } from "./decompression.ts";
import { host } from "./host.ts";

// Only the portable SDK's required Web APIs. Encoding, decompression and entropy belong to the
// native host, which reads and writes typed arrays by pointer.
class UTF8Encoder {
  encode(text = ""): Uint8Array {
    return host.encode(text);
  }
  encodeInto(text: string, destination: Uint8Array): { read: number; written: number } {
    const whole = this.encode(text);
    if (whole.length <= destination.length) {
      destination.set(whole);
      return { read: text.length, written: whole.length };
    }
    // Only part fits: whole characters, in order, until the next would overflow.
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
    return host.decode(bytes, this.encoding, this.options.fatal ?? false);
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
const URLParts = z.strictObject({
  protocol: z.string(),
  username: z.string(),
  password: z.string(),
  hostname: z.string(),
  port: z.string(),
  pathname: z.string(),
  search: z.string(),
  hash: z.string(),
});
/** Read-only absolute URLs, enough for the SDK's credential-free endpoint checks. */
class AbsoluteURL {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  constructor(input: string, base?: string) {
    const text = host.parseURL(String(input));
    if (base !== undefined || !text) throw new TypeError("Invalid URL");
    const parts = URLParts.parse(JSON.parse(text));
    this.protocol = parts.protocol;
    this.username = parts.username;
    this.password = parts.password;
    this.hostname = parts.hostname;
    this.port = parts.port;
    this.pathname = parts.pathname;
    this.search = parts.search;
    this.hash = parts.hash;
  }
  get host(): string {
    return this.port ? `${this.hostname}:${this.port}` : this.hostname;
  }
  get origin(): string {
    return `${this.protocol}//${this.host}`;
  }
  get href(): string {
    const credentials = this.username
      ? `${this.username}${this.password ? `:${this.password}` : ""}@`
      : "";
    return `${this.protocol}//${credentials}${this.host}${this.pathname}${this.search}${this.hash}`;
  }
  toString(): string {
    return this.href;
  }
}
if (typeof globalThis.URL === "undefined") Object.assign(globalThis, { URL: AbsoluteURL });
installDecompression();

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
