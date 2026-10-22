import { host } from "./host.ts";

/*
 * JavaScriptCore has no DecompressionStream, so without this the shared client never asks for
 * compressed file parts. This one covers what the client uses (one writer, one reader, whole
 * inputs) and hands the work to native zlib, which checks gzip's CRC and length.
 */
const formats = new Set(["gzip", "deflate", "deflate-raw"]);

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

export class NativeDecompressionStream {
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
    if (!formats.has(format)) throw new TypeError(`Unsupported compression format: ${format}`);
    const parts: Uint8Array[] = [];
    const { promise: output, resolve: finish } = Promise.withResolvers<Uint8Array | Error>();
    let delivered = false;
    this.writable = {
      getWriter: () => ({
        write: async (chunk) => {
          parts.push(new Uint8Array(chunk));
        },
        close: async () => {
          const expanded = host.inflate(join(parts), format);
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
}

/** Installs the native-backed decompressor where the platform has none. */
export function installDecompression(): void {
  if (typeof globalThis.DecompressionStream === "undefined")
    Object.assign(globalThis, { DecompressionStream: NativeDecompressionStream });
}
