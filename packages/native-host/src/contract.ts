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
  | "trace"
  /**
   * `loopback`: listeners on the device's own `127.0.0.1` and `::1` (ADR 0194), opened with
   * `loopback.listen`, their connections moved with `loopback(...)` and `aceLoopback`.
   */
  | "loopback"
  /**
   * `socketBytes`: one binary message on an open socket, read by pointer (a tunnel's frames,
   * ADR 0194); native code answers `aceSocket(id, "sent", "<bytes>")` once it has sent it.
   */
  | "socketBytes";

/** What `storage.value.*` keeps: one value per key, each owned by one shared module. */
export type KeptValueKey = "review" | "files" | "runAlerts";

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
  /** Failed sends the person took back or discarded (`apps/ios/bridge/dismissed-sends.ts`). */
  "storage.dismissed.load": { input: null; body: never };
  "storage.dismissed.save": { input: null; body: string };
  /**
   * Small per-device values the shared logic keeps between launches, by key: "review" (Changes
   * comments and viewed marks), "files" (recent and open files). "" when nothing is kept.
   */
  "storage.value.load": { input: { key: KeptValueKey }; body: never };
  /** A plain replace; native code bounds each value at 1 MiB. */
  "storage.value.save": { input: { key: KeptValueKey }; body: string };
  /** Each thread's side panel on a tablet (`@ace/ui-core/tablet-workspace`). */
  "storage.workspace.load": { input: null; body: never };
  "storage.workspace.save": { input: null; body: string };
  /** What the inbox draws first at the next launch. */
  "inbox.checkpoint": { input: null; body: string };
  /** SDK read snapshots (ADR 0030); "" for a miss. */
  "snapshot.get": { input: string; body: never };
  "snapshot.set": { input: { key: string }; body: string };
  "snapshot.clear": { input: null; body: never };
  /**
   * A thread kept as rows (ADR 0105), keyed like `snapshot.get`: answers "" for a miss, else the
   * head's JSON and then each item's JSON, one per line.
   */
  "snapshot.thread.get": { input: string; body: never };
  /**
   * One thread write, all or nothing. `body` is the head's JSON and then the JSON of each item in
   * `ids`, one per line. `removed` items are deleted; `replace` deletes every item first.
   */
  "snapshot.thread.put": {
    input: { key: string; settled: boolean; ids: string[]; removed: string[]; replace: boolean };
    body: string;
  };
  /** Everything kept: a JSON array of `{key, kind, used, bytes, settled}`. */
  "snapshot.index": { input: null; body: never };
  /** Lets the named records and threads go. */
  "snapshot.drop": { input: { keys: string[] }; body: never };
  /** How many bytes the snapshot store takes on disk, as decimal text. */
  "snapshot.size": { input: null; body: never };
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
  /**
   * The hello's credential: an account machine's current device grant (`{"grant": …}`), or, in
   * the debug fixture only, the loopback daemon's.
   */
  credential: { input: null; body: never };
  /**
   * An account machine's next device grant, fetched now, never one kept from an earlier
   * connection: sent on an open socket before its grant runs out (ADR 0114). `{"grant": …}`.
   */
  "credential.fresh": { input: null; body: never };
  /**
   * A live source's delivery as the shared script last set it (ADR 0147 §4): the generation of
   * its latest subscribe, and the way its pictures come, `"channel"` or a media socket's id
   * (`socket(id, "open", {media})`), or null while that subscribe's reply is pending. Native code
   * draws and acknowledges only what came that way, with that generation, holds what comes while
   * pending (bounded), starts its decoder over on another generation, and ignores an update
   * older (by `revision`) than the one it holds. It decides nothing else.
   */
  "media.delivery": {
    input: {
      view: "browser" | "screen" | "device";
      source: string;
      generation: number;
      /**
       * Counts up with every `media.delivery` this script sends, in the order it sent them: native
       * code ignores one older than the update it holds. A generation may come back (a failed
       * subscribe falls back to the delivery it replaced), so the order is this, not the generation.
       */
      revision: number;
      path: string | null;
      /**
       * The poster this subscribe's reply brought back, as native code named it in the reply
       * (`media.poster.jpeg`, a token: the JPEG itself never enters the script). Native code
       * shows it only for this source and generation, until the first live picture.
       */
      poster: string | null;
    };
    body: never;
  };
  /** Base64 of up to `limit` bytes of a staged photo or file. */
  "attachment.chunk": { input: { localId: string; offset: number; limit: number }; body: never };
  /**
   * A file the shared logic saves to the device a chunk at a time (a checkout file or a folder's
   * archive), so its bytes never pile up in the script. `open` starts an empty file named `name`
   * in the app's temporary storage under the script's `id` (a uuid), replacing any left there.
   */
  "download.open": { input: { id: string; name: string }; body: never };
  /**
   * Base64 bytes added at `offset`, which must equal the file's current length; anything else
   * fails "invalid", so a repeated or skipped chunk never corrupts the file.
   */
  "download.append": { input: { id: string; offset: number }; body: string };
  /** The file is complete: answers its absolute path, for the share sheet or Save to Files. */
  "download.finish": { input: { id: string }; body: never };
  /** Removes the file (stopped, failed, or shared and done with). Absent is fine. */
  "download.discard": { input: { id: string }; body: never };
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
  /** Deletes the device's copy of a file being saved, whole or partial (a failed or cancelled save). */
  "file.discard": { input: { id: string; name: string }; body: never };
  /**
   * A captured image (base64 body) staged as a message file; answers its `Picked` JSON
   * (`localId`, `name`, `mimeType`, `bytes`, `sha256`).
   */
  "capture.stage": { input: { name: string; mimeType: string }; body: string };
  /**
   * The ports this runtime listens on at the device's loopback (ADR 0194), replacing the ones it
   * listened on before; `[]` closes them all. A port is taken on both `127.0.0.1` and `::1`.
   * One runtime holds the device's loopback at a time: asking for ports takes them from any other,
   * which hears `aceLoopback("released", "", 0)` and has its listeners closed (connections it
   * accepted stay open). Answers `LoopbackListening` as JSON once every listener is up or failed.
   */
  "loopback.listen": { input: { ports: number[] }; body: never };
}

/** What `loopback.listen` answers: the ports now listened on, and those another app holds. */
export interface LoopbackListening {
  listening: number[];
  busy: number[];
}
export type HostOperation = keyof HostOperations;

/**
 * Socket actions the script asks for; native answers through `aceSocket`. `send` is one text
 * message; `bytes` one binary message, its value base64 (a media connection's hello).
 */
export type SocketAction = "open" | "send" | "bytes" | "close";

/**
 * What `socket(id, "open", value)` opens: "" for the runtime's own daemon socket, or this as JSON
 * for a media connection (ADR 0147 §4). `url` is the `media.connect` address of ace-media's
 * listener, held by native code to the runtime's own trust (the daemon's pinned WSS). Without
 * it, or whenever the runtime reaches its machine through the relay, native code opens a relay
 * stream with the `media` purpose. Native code only carries the connection: the ticket, hello,
 * acks and reconnecting stay in the script. Stream pieces arriving on it go to the native live
 * views exactly as the daemon socket's do.
 */
export interface MediaSocketOpen {
  media: { url?: string };
}

/**
 * What the script asks of one accepted loopback connection:
 * - `read`: deliver the next chunk (at most 64 KiB) as `aceLoopback("data", id, bytes)`. Native
 *   code reads only when asked, so the device side is paced by the tunnel's credit.
 * - `write`: send `bytes` to the connection; `aceLoopback("written", id, 0)` once sent.
 * - `end`: no more bytes from the machine (half-close); reading may go on.
 * - `reset`: drop the connection at once.
 */
export type LoopbackAction = "read" | "write" | "end" | "reset";

/**
 * What native code tells the script about the loopback (`aceLoopback(event, id, value)`):
 * `accept` (a new connection `id`, value the port), `data` (bytes), `written`, `end` (the page
 * sent all it will), `reset` (the connection failed or was dropped) and `released` (another
 * runtime took the listeners; `id` is "").
 */
export type LoopbackEvent = "accept" | "data" | "written" | "end" | "reset" | "released";

/** What native code installs as `globalThis.aceHost` before the bundle runs. */
export interface NativeHost {
  /** Native video codecs, preferred first; absent hosts use H.264. */
  readonly video?: { decoders(): string[] };
  readonly version: number;
  readonly capabilities: readonly OptionalCapability[];

  // Clock, identity and entropy.
  /**
   * Epoch milliseconds, whole, as `Date.now()`: protocol Timestamps are built from it. Never for
   * timing work: it can't tell a sub-millisecond span from none, and it moves with the wall clock.
   */
  now(): number;
  /**
   * Milliseconds on a monotonic clock, with fractions (`performance.now()`, the device's uptime):
   * for measuring how long work takes, never for a date. Its zero is arbitrary.
   */
  monotonicMs(): number;
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
  /** One binary message on socket `id`, read by pointer during the call (`socketBytes`). */
  socketBytes?(id: string, bytes: Uint8Array): void;

  // The device's loopback (`loopback`).
  /** `bytes` only with `write`, read by pointer during the call. */
  loopback?(connection: string, action: LoopbackAction, bytes?: Uint8Array): void;

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
  /** A loopback event (`LoopbackEvent`), when the host offers `loopback`. */
  aceLoopback?(event: string, connection: string, value: number | Uint8Array): void;
}

/** Every function a host must have, checked once when the bundle starts. */
export const requiredFunctions = [
  "now",
  "monotonicMs",
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
