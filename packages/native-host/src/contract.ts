/*
 * The one door between ace's shared mobile logic (run in JavaScriptCore on iOS, and in a JS
 * engine on Android) and the platform (ADR 0096). Native code implements these capabilities
 * and nothing else: no status rules, no grouping, no protocol decisions.
 *
 * Bytes: a `Uint8Array` passed in is read by pointer for the length of the call, never copied
 * into an array of numbers. A `Uint8Array` returned is made once by native code. Text crosses
 * as engine strings. Large text bodies for async operations travel unescaped in `body`.
 */

/** The contract version this logic was written against. Breaking changes raise it. */
export const HOST_CONTRACT_VERSION = 1;

/** Capabilities a host may lack; the logic checks for each before use. */
export type OptionalCapability =
  /** zlib: `inflate` (gzip, deflate, deflate-raw). Without it the daemon never compresses. */
  | "inflate"
  /** `trace`: totals of spans the script times itself (diagnostics only). */
  | "trace";

/** Formats `inflate` expands. */
export type InflateFormat = "gzip" | "deflate" | "deflate-raw";

/** What a failed async operation reports: a short code, never a localized sentence. */
export type HostErrorCode =
  | "unsupported"
  | "storage"
  | "identity"
  | "invalid"
  /** Pinned HTTP refusals. */
  | "pin"
  | "redirect"
  | "offline"
  | "limit"
  | "failed";

/** Answers one async operation: `(code, "")` on failure, `(null, text)` on success. */
export type HostReply = (error: string | null, value: string) => void;

/**
 * Async platform operations: what each takes as `input` (sent as JSON) and `body` (sent as is),
 * and what text it answers with. Native code owns the storage, Keychain and network behind them.
 */
export interface HostOperations {
  /** The outbox database (`ClientCore` storage), one per daemon and device. */
  "storage.load": { input: null; body: never };
  "storage.save": { input: null; body: string };
  "storage.host.load": { input: null; body: never };
  "storage.host.save": { input: null; body: string };
  /** Answers a JSON array of record texts, oldest first. */
  "storage.records": { input: null; body: never };
  /** `body` absent deletes the record. */
  "storage.write": { input: { id: string }; body: string | undefined };
  /** The bridge's kept service reads. */
  "storage.reads.load": { input: null; body: never };
  "storage.reads.save": { input: null; body: string };
  /** The browser's device toolbar per tab (`@ace/ui-core/browser-device-settings`). */
  "storage.devices.load": { input: null; body: never };
  "storage.devices.save": { input: null; body: string };
  /** What the inbox draws first at the next launch. */
  "inbox.checkpoint": { input: null; body: string };
  /** SDK read snapshots (ADR 0030); "" for a miss. */
  "snapshot.get": { input: string; body: never };
  "snapshot.set": { input: { key: string }; body: string };
  "snapshot.clear": { input: null; body: never };
  /** Keychain, limited by native code to the keys this runtime may touch. */
  "secret.get": { input: string; body: never };
  "secret.set": { input: { key: string; token: string }; body: never };
  "secret.delete": { input: string; body: never };
  /** The non-secret machine directory. */
  "directory.load": { input: null; body: never };
  "directory.save": { input: null; body: string };
  /** HTTPS to this runtime's own pinned daemon; answers `{status, body}` JSON. */
  http: {
    input: { method: string; path: string; body?: string | undefined; token?: string | undefined };
    body: never;
  };
  /** Debug fixture only: the loopback daemon's credential. */
  credential: { input: null; body: never };
  /** Base64 of up to `limit` bytes of a staged photo or file. */
  "attachment.chunk": { input: { localId: string; offset: number; limit: number }; body: never };
  /** An access runtime's single result. */
  "access.result": { input: null; body: string };
  /**
   * Base64 bytes appended at `offset` to the device's copy of a file being saved (a browser
   * download); `done` closes it so the platform can offer it. `offset` 0 starts the file again.
   */
  "file.write": {
    input: { id: string; name: string; offset: number; done: boolean };
    body: string;
  };
  /**
   * A captured image (base64 body) staged as a message file; answers its `Picked` JSON
   * (`localId`, `name`, `mimeType`, `bytes`, `sha256`).
   */
  "capture.stage": { input: { name: string; mimeType: string }; body: string };
}
export type HostOperation = keyof HostOperations;

/** Socket actions the script asks for; native answers through `aceSocket`. */
export type SocketAction = "open" | "send" | "close";

/** What native code installs as `globalThis.aceHost` before the bundle runs. */
export interface NativeHost {
  readonly version: number;
  readonly capabilities: readonly OptionalCapability[];

  // Clock, identity and entropy.
  now(): number;
  uuid(): string;
  /** Uniform in [0, 1). */
  random(): number;
  /** Cryptographically random bytes, at most 65,536. */
  randomBytes(count: number): Uint8Array;

  // Scheduling: one-shot timers whose callbacks run on the script's thread.
  timer(id: string, delay: number, callback: () => void): void;
  cancelTimer(id: string): void;

  // Text.
  /** UTF-8 bytes of `text`; ill-formed UTF-16 becomes U+FFFD. */
  encode(text: string): Uint8Array;
  /** Bytes as text in `encoding` (utf-8 or utf-16le); with `fatal`, invalid bytes throw. */
  decode(bytes: Uint8Array, encoding: string, fatal: boolean): string;
  /** How many UTF-8 bytes `text` takes, without making them. */
  utf8Length(text: string): number;
  /** At most `limit` UTF-16 units from the start (or end), cut at a grapheme boundary. */
  previewHead(text: string, limit: number): string;
  previewTail(text: string, limit: number): string;

  // Bytes.
  /** Standard base64 of a binary string (`btoa`), or the reverse (`atob`); "" when invalid. */
  latin1Base64(text: string, decode: boolean): string;
  /** One whole compressed input expanded (capped natively at 16 MiB); null when it can't be. */
  inflate?(bytes: Uint8Array, format: InflateFormat): Uint8Array | null;

  /** Absolute URL parts as JSON, or "" when it can't be parsed. */
  parseURL(text: string): string;

  // Platform work that answers later.
  call(operation: string, input: string, body: string | undefined, done: HostReply): void;

  // Outbound streams.
  /** One frame of display patches: a JSON array of at most 32 patches and 32 KiB UTF-8. */
  emit(frame: string): void;
  socket(id: string, action: SocketAction, value: string): void;

  // Diagnostics.
  readonly tracing?: boolean;
  trace?(name: string, ms: number, bytes: number): void;
}

/** What the bundle installs on `globalThis` for native code to call. */
export interface HostEntries {
  /** Starts a machine runtime with its JSON config. */
  aceStart(json: string): void;
  /** One UI action as JSON. */
  aceAction(json: string): void;
  /** Native accepted (or rejected) the last emitted frame. */
  aceAck(accepted: boolean): void;
  /** A socket event: open, message (text), binary (bytes), trust (a refusal) or close (code). */
  aceSocket(id: string, type: string, value: string | Uint8Array): void;
  /** Starts a pairing or machine-directory runtime with its JSON request. */
  aceAccess(json: string): void;
}

/** Every function a host must have, checked once when the bundle starts. */
export const requiredFunctions = [
  "now",
  "uuid",
  "random",
  "randomBytes",
  "timer",
  "cancelTimer",
  "encode",
  "decode",
  "utf8Length",
  "previewHead",
  "previewTail",
  "latin1Base64",
  "parseURL",
  "call",
  "emit",
  "socket",
] as const satisfies readonly (keyof NativeHost)[];
