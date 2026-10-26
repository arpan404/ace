import { z } from "zod";
import { hasCapability } from "./connect.ts";
import type { InflateFormat, NativeHost } from "./contract.ts";

/*
 * The Web APIs the shared client needs that a bare JS engine lacks, each backed by the host:
 * text encoding, URL, AbortController, base64, entropy and (with `inflate`) DecompressionStream.
 * Only what the engine is missing is installed.
 */

class UTF8Encoder {
  readonly #host: NativeHost;
  readonly encoding = "utf-8";
  constructor(host: NativeHost) {
    this.#host = host;
  }
  encode(text = ""): Uint8Array {
    return this.#host.encode(text);
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
  readonly #host: NativeHost;
  readonly encoding: string;
  readonly fatal: boolean;
  constructor(host: NativeHost, encoding = "utf-8", options: { fatal?: boolean } = {}) {
    this.#host = host;
    this.encoding = encoding.toLowerCase() === "utf8" ? "utf-8" : encoding.toLowerCase();
    this.fatal = options.fatal ?? false;
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return "";
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return this.#host.decode(bytes, this.encoding, this.fatal);
  }
}

class CancellationSignal {
  aborted = false;
  reason: unknown;
  readonly #listeners = new Set<() => void>();
  addEventListener(_type: string, callback: () => void): void {
    this.#listeners.add(callback);
  }
  removeEventListener(_type: string, callback: () => void): void {
    this.#listeners.delete(callback);
  }
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }
  abort(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
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
function absoluteURL(host: NativeHost) {
  return class AbsoluteURL {
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
  };
}

const formats = new Set<string>(["gzip", "deflate", "deflate-raw"]);
const isFormat = (format: string): format is InflateFormat => formats.has(format);

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  return whole;
}

/**
 * A `DecompressionStream` covering what the client uses (one writer, one reader, whole inputs),
 * expanded in one host call; native zlib checks gzip's CRC and length.
 */
function decompressionStream(inflate: NonNullable<NativeHost["inflate"]>) {
  return class HostDecompressionStream {
    readonly writable: {
      getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
    };
    readonly readable: {
      getReader(): {
        read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>;
        cancel(): Promise<void>;
      };
    };
    constructor(format: string) {
      if (!isFormat(format)) throw new TypeError(`Unsupported compression format: ${format}`);
      const parts: Uint8Array[] = [];
      const { promise: output, resolve: finish } = Promise.withResolvers<Uint8Array | Error>();
      let delivered = false;
      this.writable = {
        getWriter: () => ({
          write: async (chunk) => {
            parts.push(new Uint8Array(chunk));
          },
          close: async () => {
            const expanded = inflate(join(parts), format);
            finish(expanded ?? new TypeError("Invalid compressed data"));
          },
        }),
      };
      this.readable = {
        getReader: () => ({
          read: async () => {
            const result = await output;
            if (result instanceof Error) throw result;
            if (delivered || result.length === 0) return { done: true };
            delivered = true;
            return { done: false, value: result };
          },
          cancel: async () => {
            delivered = true;
          },
        }),
      };
    }
  };
}

/** Installs, on `target`, each Web API the engine lacks, backed by `host`. */
export function installWebPlatform(host: NativeHost, target: object = globalThis): void {
  const missing = (name: string) => typeof Reflect.get(target, name) === "undefined";
  const add = (name: string, value: unknown) => {
    if (missing(name)) Reflect.set(target, name, value);
  };
  add(
    "TextEncoder",
    class extends UTF8Encoder {
      constructor() {
        super(host);
      }
    },
  );
  add(
    "TextDecoder",
    class extends UTF8Decoder {
      constructor(encoding?: string, options?: { fatal?: boolean }) {
        super(host, encoding, options);
      }
    },
  );
  add("URL", absoluteURL(host));
  add("AbortController", CancellationController);
  add("queueMicrotask", (callback: () => void) => {
    void Promise.resolve().then(callback);
  });
  add("btoa", (value: string) => host.latin1Base64(value, false));
  add("atob", (value: string) => host.latin1Base64(value, true));
  add("crypto", {
    randomUUID: () => host.uuid(),
    getRandomValues: <T extends Uint8Array>(array: T): T => {
      if (array.byteLength > 65536) throw new Error("Entropy request exceeds 64 KiB");
      array.set(host.randomBytes(array.length));
      return array;
    },
  });
  const inflate = host.inflate;
  if (inflate && hasCapability(host, "inflate"))
    add("DecompressionStream", decompressionStream(inflate.bind(host)));
}
