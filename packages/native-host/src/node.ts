import { randomBytes } from "node:crypto";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import {
  HOST_CONTRACT_VERSION,
  type HostOperation,
  type InflateFormat,
  type NativeHost,
  type OptionalCapability,
  type SocketAction,
} from "./contract.ts";

/*
 * The host contract on Node, so the shared mobile logic runs under Vitest exactly as it runs in
 * JavaScriptCore. Clock, ids and randomness are injected; async operations are answered by
 * handlers the test registers; emitted frames and socket actions are recorded.
 */

/** Answers one async operation; a thrown `HostCallError`-style code (or Error message) fails it. */
export type NodeOperation = (input: unknown, body: string | undefined) => Promise<string> | string;

export interface NodeHostOptions {
  now?: () => number;
  uuid?: () => string;
  random?: () => number;
  randomBytes?: (count: number) => Uint8Array;
  /** Called with each emitted frame, already parsed. */
  emit?: (frame: string) => void;
  socket?: (id: string, action: SocketAction, value: string) => void;
  operations?: Partial<Record<HostOperation, NodeOperation>>;
  /** Leave out optional capabilities, to test the logic without them. */
  without?: readonly OptionalCapability[];
}

/** What native caps an expansion at (`NativeBytes.inflateCeiling`). */
const inflateCeiling = 16 * 1024 * 1024;

const expanders = { gzip: gunzipSync, deflate: inflateSync, "deflate-raw": inflateRawSync };

/** Grapheme-safe previews, as the iOS host cuts them (`DisplayText.swift`): a cut head ends in "…". */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function wellFormed(text: string): string {
  return text.toWellFormed();
}
function head(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return wellFormed(text);
  let end = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (end + segment.length > limit) break;
    end += segment.length;
  }
  return `${wellFormed(text.slice(0, end))}…`;
}
function tail(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return wellFormed(text);
  let start = text.length;
  const parts = [...graphemes.segment(text)];
  for (let index = parts.length - 1; index >= 0; index--) {
    const segment = parts[index]?.segment ?? "";
    if (text.length - (start - segment.length) > limit) break;
    start -= segment.length;
  }
  return wellFormed(text.slice(start));
}

export interface NodeHost extends NativeHost {
  /** Registers or replaces the handler for one operation. */
  handle(operation: HostOperation, handler: NodeOperation): void;
}

export function createNodeHost(options: NodeHostOptions = {}): NodeHost {
  let next = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const operations = new Map<string, NodeOperation>(Object.entries(options.operations ?? {}));
  const without = new Set(options.without ?? []);
  const capabilities = (["inflate", "trace"] as const).filter((name) => !without.has(name));
  const host: NodeHost = {
    version: HOST_CONTRACT_VERSION,
    capabilities,
    now: options.now ?? (() => Date.now()),
    uuid: options.uuid ?? (() => `id-${++next}`),
    random: options.random ?? (() => 0.5),
    randomBytes: (count) => {
      if (count < 0 || count > 65536) throw new Error("Entropy request exceeds 64 KiB");
      return options.randomBytes?.(count) ?? new Uint8Array(randomBytes(count));
    },
    timer(id, delay, callback) {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          callback();
        }, delay),
      );
    },
    cancelTimer(id) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    },
    encode: (text) => new Uint8Array(Buffer.from(text.toWellFormed(), "utf8")),
    decode: (bytes, encoding, fatal) => new TextDecoder(encoding, { fatal }).decode(bytes),
    utf8Length: (text) => Buffer.byteLength(text.toWellFormed(), "utf8"),
    previewHead: head,
    previewTail: tail,
    latin1Base64: (text, decode) => {
      if (!decode) return Buffer.from(text, "latin1").toString("base64");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4) return "";
      return Buffer.from(text, "base64").toString("latin1");
    },
    parseURL(text) {
      try {
        const url = new URL(text);
        const { protocol, username, password, hostname, port, pathname, search, hash } = url;
        return JSON.stringify({
          protocol,
          username,
          password,
          hostname,
          port,
          pathname,
          search,
          hash,
        });
      } catch {
        return "";
      }
    },
    call(operation, input, body, done) {
      const handler = operations.get(operation);
      if (!handler) {
        setTimeout(() => done("unsupported", ""), 0);
        return;
      }
      Promise.resolve()
        .then(() => handler(JSON.parse(input), body))
        .then(
          (value) => done(null, value),
          (error: unknown) => done(error instanceof Error ? error.message : "failed", ""),
        );
    },
    emit: (frame) => options.emit?.(frame),
    socket: (id, action, value) => options.socket?.(id, action, value),
    handle(operation, handler) {
      operations.set(operation, handler);
    },
  };
  if (!without.has("inflate"))
    host.inflate = (bytes: Uint8Array, format: InflateFormat) => {
      const expand = expanders[format];
      if (!expand) return null;
      try {
        return new Uint8Array(expand(bytes, { maxOutputLength: inflateCeiling }));
      } catch {
        return null;
      }
    };
  if (!without.has("trace")) host.trace = () => {};
  return host;
}
