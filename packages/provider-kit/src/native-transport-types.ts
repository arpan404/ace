// SPDX-License-Identifier: Apache-2.0

/** An upgrade's decision, as the admission state machine asks TypeScript for it. */
export type TransportDecision = "accept" | "forbidden" | "unavailable" | "closing" | "drop";

/** One upgrade candidate, as the native listener asks TypeScript to admit it. */
export interface TransportAdmitRequest {
  /** This upgrade; it decides nothing else. */
  id: number;
  /** The request-target exactly as received, never a parsed path. */
  target: string;
  origin: string | null | undefined;
  /** The app's socket tag, carried to registration with the reservation. */
  appSocketTag?: string | null;
  /** The client's address, as the accepted socket reports it. */
  address: string;
}

/** Admission's answer: a decision, and the capacity slot an acceptance took. */
export interface TransportAdmitAnswer {
  decision: TransportDecision;
  reservation: number;
}

/** What `NativeLoopback.start` binds, and what it forwards HTTP to. */
export interface TransportStartOptions {
  /** The public port; `0` picks a free one. */
  port: number;
  /** The internal server the proxy hop forwards to, on 127.0.0.1. */
  targetPort: number;
  /** This boot's hop secret as hex: kept in memory and passed back, never logged. */
  secretHex: string;
  /** How long admission may take; the shell's 5,000 when it names none. */
  admitTimeoutMs: number;
}

/** One socket's events, in the socket's order, as the binding delivers them. */
export type NativeSocketEvent =
  | { kind: "message"; data: Buffer; binary: boolean; charge: number }
  | { kind: "sent"; id: number; error: string | null | undefined }
  | { kind: "error"; code: "too_big" | "protocol" | "io"; message: string }
  | { kind: "close"; code: number; reason: Buffer };

/**
 * What a `send` did: `queued` (and then exactly one `sent` is owed), or why
 * nothing was queued. `not-open` is a close race and takes `ws`'s send-after-close
 * path; `full` is the outbound queue at its bound, and `invalid-utf8` a text send
 * that is not UTF-8. The last two fail only that send's callback.
 */
export type NativeSendResult = "queued" | "not-open" | "full" | "invalid-utf8";

/** A socket as JavaScript holds it: `ws`'s methods over the Rust socket. */
export interface NativeSocketHandle {
  /** Delivers this socket's events, in order; they queue in Rust until this call. */
  listen(events: (event: NativeSocketEvent) => void): void;
  /** `ws`'s send while open: what happened to the frame, and which `sent` it owes. */
  send(data: Buffer, binary: boolean, compress: boolean, id: number): NativeSendResult;
  close(code: number | null, reason: string): void;
  terminate(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  bufferedAmount(): number;
  readyState(): number;
}

/** The bound listener: its port, its counters, and a close that resolves when its sockets did. */
export interface NativeLoopbackHandle {
  port(): number;
  /** What this listener handled since it bound (T1b.5's evidence). */
  handled(): NativeHandled;
  close(deadlineMs: number): Promise<void>;
}

/** What one native listener handled since it bound, as T1b.5's evidence reads it. */
export interface NativeHandled {
  connections: number;
  exchanges: number;
  upgrades: number;
  trustedHandshakes: number;
  postQuantumHandshakes: number;
  deflatedOut: number;
  inflatedIn: number;
}

/** A remote listener's connection timers, as `ConnectionLimits` takes them. */
export interface NativeRemoteLimits {
  handshakeMs: number;
  firstHeadMs: number;
  /** None: only the idle timer bounds a later head. */
  headMs: number | null | undefined;
  keepAliveMs: number;
  /** None: no trusted keep-alive (the static listener). */
  trustedKeepAliveMs: number | null | undefined;
}

/** What `NativeRemote.start` binds, and what it forwards HTTP to. */
export interface NativeRemoteStartOptions {
  host: string;
  port: number;
  /** The internal server the proxy hop forwards to, on 127.0.0.1. */
  targetPort: number;
  secretHex: string;
  admitTimeoutMs: number;
  /** The identity's PEM bytes exactly as `loadIdentity` read them. */
  cert: Buffer;
  key: Buffer;
  limits: NativeRemoteLimits;
}

/** The bound remote listener: its port, its certificate and a close that waits for its sockets. */
export interface NativeRemoteHandle {
  port(): number;
  /** Serves `name` the trusted certificate from the next handshake on. */
  setTrusted(name: string, cert: Buffer, key: Buffer): void;
  clearTrusted(): void;
  handled(): NativeHandled;
  close(deadlineMs: number): Promise<void>;
}

/** The addon's `NativeRemote` class: static, because the listener is built by `start`. */
export interface NativeRemoteClass {
  /** Parses the PEM as `start` will, and throws naming what is unusable. Synchronous. */
  checkIdentity(cert: Buffer, key: Buffer): void;
  start(
    options: NativeRemoteStartOptions,
    admit: (request: TransportAdmitRequest) => Promise<TransportAdmitAnswer>,
    release: (reservation: number) => void,
    opened: (
      socket: NativeSocketHandle,
      reservation: number,
      userAgent: string | null | undefined,
    ) => void,
    /** An accept failure after the bind, throttled per OS code by the binding. */
    error: (code: string, message: string, repeated: number) => void,
  ): Promise<NativeRemoteHandle>;
}

/** The addon's `NativeLoopback` class: static, because the listener is built by `start`. */
export interface NativeLoopbackClass {
  /** 32 bytes from the OS CSPRNG as hex, once per boot. */
  generateSecret(): string;
  start(
    options: TransportStartOptions,
    /** Admission's word, as a promise; the state machine owns every release. */
    admit: (request: TransportAdmitRequest) => Promise<TransportAdmitAnswer>,
    /** TypeScript drops one reservation. Idempotent: an id it no longer holds is ignored. */
    release: (reservation: number) => void,
    /** One socket whose `101` is on the wire, for TypeScript to register and read. */
    opened: (
      socket: NativeSocketHandle,
      reservation: number,
      userAgent: string | null | undefined,
    ) => void,
  ): Promise<NativeLoopbackHandle>;
  /** Unpaired delivery debits this process has seen: zero unless `ace-transport` has a bug. */
  underflowCount(): number;
}

/** What `ace-daemon-node`'s transport binding exports. */
export interface TransportAddon {
  NativeLoopback: NativeLoopbackClass;
  /** Present in a build of this tree; an older addon may not export it. */
  NativeRemote?: NativeRemoteClass | undefined;
}
