// SPDX-License-Identifier: Apache-2.0
/**
 * The native streams shell behind `ACE_SUPERVISOR=native` (E2b): line framing,
 * the output gates, dropped-line notes, JSONL framing, the SSE parser and the
 * JSON-RPC protocol state `ace-supervisor` owns. The JavaScript half each caller
 * already depends on stays here: readline interfaces, stream Transforms, promises,
 * timers, flow pauses and the stdin writes. Every function in this file is called
 * only after its owning module asked `supervisorBackend()`, so TypeScript callers
 * never change.
 */

import { createInterface, type Interface } from "node:readline";
import { PassThrough, Transform, type Readable, type Writable } from "node:stream";
import { supervisorAddon } from "./native-process.ts";

/** A JavaScript string as the JSON-RPC ids accept them. */
type RpcIdValue = string | number;

/** One `DroppedOutputLine` as the addon reports it. */
interface NativeDroppedLine {
  bytes: number;
  prefix: string;
  phase: "start" | "end" | "complete";
}

interface NativeFramedPart {
  kind: "data" | "drop";
  data?: Uint8Array | null;
  line?: NativeDroppedLine | null;
}

interface NativeNoteStep {
  note?: string | null;
  arm: boolean;
}

interface NativeEncoded {
  line: string;
  bytes: number;
}

interface NativeInspection {
  kind: "unparsable" | "malformed" | "request" | "notification" | "response";
  id?: RpcIdValue | null;
  method?: string | null;
  paramsJson?: string | null;
  resultJson?: string | null;
  error?: string | null;
}

interface NativeLineFramer {
  push(chunk: Uint8Array): string[];
  finish(): string[];
}

interface NativeWriterQueue {
  enqueue(bytes: number): number;
  claim(): number | null | undefined;
  written(ticket: number): void;
  cancel(ticket: number): boolean;
  setBlocked(blocked: boolean): void;
  active(): number | null | undefined;
  close(): number[];
}

/** The streams surface of the addon `ace-daemon-node/src/streams.rs` declares. */
interface StreamsAddon {
  LineFramerNative: new (maxBytes: number) => NativeLineFramer;
  lineRestore(text: string): string;
  streamByteLimit(value: number, name: string): number;
  OutputGateNative: new (maxLineBytes: number | undefined) => {
    push(chunk: Uint8Array): string | null | undefined;
  };
  DroppingGateNative: new (limit: number) => {
    push(chunk: Uint8Array): NativeFramedPart[];
    finish(): NativeFramedPart[];
    stop(): void;
  };
  DroppedNotesNative: new () => {
    dropped(bytes: number, phase: string): NativeNoteStep;
    fire(): NativeNoteStep;
    flush(): string | null | undefined;
  };
  JsonLinesNative: new (maxBytes: number) => {
    push(chunk: Uint8Array): { lines: string[]; error?: string | null };
    finish(paused: boolean): string | null | undefined;
  };
  SseParserNative: new (
    maxLineBytes: number,
    maxEventBytes: number,
    lastEventId: string,
  ) => {
    feed(text: string): {
      events: { data: string; event: string; id: string }[];
      error?: string | null;
    };
    lastEventId(): string;
    retryMs(): number | null | undefined;
  };
  RpcIdsNative: new (maxExplicit: number) => {
    reserve(id?: RpcIdValue): RpcIdValue;
  };
  WriterQueueNative: new (maxQueuedBytes: number) => NativeWriterQueue;
  rpcEncodeRequest(idJson: string, method: string, paramsJson?: string): NativeEncoded;
  rpcEncodeNotification(method: string, paramsJson?: string): NativeEncoded;
  rpcEncodeAnswer(
    idJson: string,
    resultJson?: string,
    errorCode?: number,
    errorMessage?: string,
  ): NativeEncoded;
  rpcInspect(line: string): NativeInspection;
  rpcErrorCode(message: string): number | null | undefined;
  ReaderFlowNative: new () => {
    beginDrain(): boolean;
    endDrain(): void;
    block(): void;
    unblock(): void;
    isBlocked(): boolean;
    fail(): void;
    isFailed(): boolean;
    detach(): void;
    isDetached(): boolean;
  };
}

function streams(): StreamsAddon {
  // Trusted: the addon this tree built, with the exports `streams.rs` declares.
  return supervisorAddon() as unknown as StreamsAddon;
}

/** `byteLimit`: a positive safe integer, or the RangeError it threw. */
export function nativeByteLimit(value: number, name: string): number {
  return streams().streamByteLimit(value, name);
}

/** The shield `line-reader.ts` uses; native protection writes it before a digit. */
const SHIELD = "\uFDD0";

/** The last line of an input that ended without one, protected like every other. */
function restoreLine(line: string): string {
  return line.includes(SHIELD) ? streams().lineRestore(line) : line;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * `lineReader`: one native framer per pipe, readline still delivering the lines
 * (pause, resume and async iteration stay node's).
 */
export function nativeLineReader(
  input: Readable,
  maxBytes: number,
  fail: (error: Error) => void,
  flow: { paused(): boolean; wait(): Promise<void> } | undefined,
  limitError: (message: string) => Error,
): Interface {
  const framer = new (streams().LineFramerNative)(maxBytes);
  const state = new (streams().ReaderFlowNative)();
  const source = new PassThrough({ highWaterMark: 1 });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  let pending: string[] = [];
  let next = 0;
  let ending = false;
  let failure: Error | undefined;

  const failed = (error: unknown) => {
    if (failure !== undefined) return;
    failure = asError(error);
    fail(failure);
    source.destroy();
  };
  function drain(): void {
    if (!state.beginDrain()) return;
    try {
      while (!source.isPaused()) {
        if (failure !== undefined) return;
        if (flow?.paused()) {
          state.block();
          input.pause();
          void flow.wait().then(
            () => {
              if (failure !== undefined) return;
              state.unblock();
              input.resume();
              drain();
            },
            (error: unknown) => failed(error),
          );
          return;
        }
        if (next >= pending.length) {
          pending = [];
          next = 0;
          if (ending) {
            source.end();
            return;
          }
          input.resume();
          return;
        }
        const line = pending[next];
        if (line === undefined) {
          pending = [];
          next = 0;
          continue;
        }
        next += 1;
        // The line is written protected: readline splits U+2028/U+2029, and only
        // the emitted line is restored.
        source.write(`${line}\n`);
      }
      // A paused consumer stops the pipe until readline resumes its source.
      if (!ending) input.pause();
    } catch (error) {
      failed(error);
    } finally {
      state.endDrain();
    }
  }
  const finish = () => {
    if (ending || failure !== undefined) return;
    ending = true;
    try {
      pending.push(...framer.finish());
    } catch (error) {
      failed(error);
      return;
    }
    drain();
  };
  input.on("data", (chunk: Buffer | string) => {
    if (failure !== undefined || ending) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    try {
      pending.push(...framer.push(bytes));
    } catch (error) {
      failed(limitError(asError(error).message));
      return;
    }
    drain();
  });
  input.once("end", finish);
  input.once("close", finish);
  input.on("error", failed);
  source.on("error", failed);
  source.on("resume", () => {
    if (failure !== undefined) return;
    input.resume();
    drain();
  });
  source.once("close", () => input.destroy());
  lines.once("close", () => source.destroy());
  const emit = lines.emit.bind(lines);
  // Every "line" listener (and async iteration) gets the line as the process wrote it.
  lines.emit = (event: string | symbol, ...args: unknown[]): boolean =>
    event === "line" && typeof args[0] === "string"
      ? emit(event, restoreLine(args[0]))
      : emit(event, ...args);
  return lines;
}

/** `outputGate`'s non-dropping half: admit, then the native line-byte counter. */
export function nativeOutputGate(
  maxLineBytes: number | undefined,
  admit: (bytes: number) => boolean,
  fail: (error: Error) => void,
  limitError: (message: string) => Error,
): Transform {
  const handle = new (streams().OutputGateNative)(maxLineBytes);
  let stopped = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (stopped) {
        done();
        return;
      }
      if (!admit(chunk.length)) {
        stopped = true;
        fail(limitError("Probe output exceeded limit"));
        done();
        return;
      }
      const error = handle.push(chunk);
      if (error != null) {
        stopped = true;
        fail(limitError(error));
        done();
        return;
      }
      done(null, chunk);
    },
  });
}

/** Publish one chunk's frames, keeping a run of data together until a drop. */
function publishParts(
  parts: NativeFramedPart[],
  output: (bytes: Buffer) => void,
  dropped: (line: NativeDroppedLine) => void,
): void {
  let batch: Buffer[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    output(Buffer.concat(batch));
    batch = [];
  };
  for (const part of parts) {
    if (part.kind === "data") {
      if (part.data != null) batch.push(Buffer.from(part.data));
    } else if (part.line != null) {
      flush();
      dropped(part.line);
    }
  }
  flush();
}

/** `droppingOutputGate`: hold only an admissible line; skip the rest to its delimiter. */
export function nativeDroppingOutputGate(
  limit: number,
  admit: (bytes: number) => boolean,
  fail: (error: Error) => void,
  dropped: (line: NativeDroppedLine) => void,
): Transform {
  const handle = new (streams().DroppingGateNative)(limit);
  let stopped = false;
  return new Transform({
    transform(this: Transform, chunk: Buffer, _encoding, done) {
      if (stopped) {
        done();
        return;
      }
      if (!admit(chunk.length)) {
        stopped = true;
        handle.stop();
        fail(new Error("Probe output exceeded limit"));
        done();
        return;
      }
      publishParts(handle.push(chunk), (bytes) => this.push(bytes), dropped);
      done();
    },
    flush(this: Transform, done) {
      if (!stopped) publishParts(handle.finish(), (bytes) => this.push(bytes), dropped);
      done();
    },
  });
}

/**
 * `droppedLineNotes`: the interval schedule stays here; the counts and the one
 * note per interval are native.
 */
export function nativeDroppedLineNotes(options: {
  note: (text: string) => void;
  schedule: (run: () => void, ms: number) => () => void;
  intervalMs?: number;
}): { dropped(line: NativeDroppedLine): void; flush(): void } {
  const handle = new (streams().DroppedNotesNative)();
  const intervalMs = options.intervalMs ?? 1000;
  let cancel: (() => void) | undefined;
  const arm = () => {
    cancel = options.schedule(() => {
      cancel = undefined;
      const step = handle.fire();
      if (step.note != null) options.note(step.note);
      if (step.arm) arm();
    }, intervalMs);
  };
  return {
    dropped(line) {
      const step = handle.dropped(line.bytes, line.phase);
      if (step.note != null) options.note(step.note);
      if (step.arm) arm();
    },
    flush() {
      cancel?.();
      cancel = undefined;
      const note = handle.flush();
      if (note != null) options.note(note);
    },
  };
}

/**
 * `readJsonLines`: one native framer per stream, LF framing and counting native,
 * the flow pause and the callbacks here.
 */
export function nativeReadJsonLines(
  input: Readable,
  maxBytes: number,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
  flow?: { paused(): boolean; wait(): Promise<void> },
): () => void {
  const framer = new (streams().JsonLinesNative)(maxBytes);
  const state = new (streams().ReaderFlowNative)();
  let pending: string[] = [];
  let next = 0;
  let pendingError: string | undefined;
  let failed = false;
  let detached = false;
  let ended = false;

  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    pending = [];
    next = 0;
    pendingError = undefined;
    state.fail();
    onError(new Error(message));
  };
  function drain(): void {
    if (!state.beginDrain()) return;
    try {
      for (;;) {
        if (failed || detached) return;
        if (flow?.paused()) {
          state.block();
          input.pause();
          void flow.wait().then(
            () => {
              if (failed || detached) return;
              state.unblock();
              drain();
              if (!flow.paused()) input.resume();
            },
            (error: unknown) =>
              fail(error instanceof Error ? error.message : "JSONL stream failed"),
          );
          return;
        }
        if (next >= pending.length) {
          pending = [];
          next = 0;
          if (pendingError !== undefined) {
            const message = pendingError;
            pendingError = undefined;
            fail(message);
            return;
          }
          if (!flow?.paused()) input.resume();
          return;
        }
        const line = pending[next];
        if (line === undefined) {
          pending = [];
          next = 0;
          continue;
        }
        next += 1;
        onLine(line);
      }
    } finally {
      state.endDrain();
    }
  }
  const push = (bytes: Uint8Array) => {
    const outcome = framer.push(bytes);
    if (outcome.lines.length > 0) pending.push(...outcome.lines);
    if (outcome.error != null) pendingError = outcome.error;
    drain();
  };
  const data = (chunk: unknown) => {
    if (detached || failed) return;
    if (Buffer.isBuffer(chunk)) push(chunk);
    else if (typeof chunk === "string") push(Buffer.from(chunk));
    else fail("Invalid JSONL bytes");
  };
  const end = () => {
    if (ended || detached || failed) return;
    ended = true;
    const error = framer.finish(flow?.paused() ?? false);
    if (error != null) pendingError = error;
    drain();
  };
  const error = (cause: unknown) =>
    fail(cause instanceof Error ? cause.message : "JSONL stream failed");
  input.on("data", data);
  input.once("end", end);
  input.once("error", error);
  return () => {
    detached = true;
    state.detach();
    input.removeListener("data", data);
    input.removeListener("end", end);
    input.removeListener("error", error);
    pending = [];
    next = 0;
  };
}

/**
 * The SSE parser's native half: one `feed` per chunk, the events dispatched here
 * in order, and the limits' errors thrown as `SseLimitError` by the caller's
 * factory.
 */
export class NativeSseParser {
  lastEventId: string;
  retryMs: number | undefined;
  readonly #handle: {
    feed(text: string): {
      events: { data: string; event: string; id: string }[];
      error?: string | null;
    };
    lastEventId(): string;
    retryMs(): number | null | undefined;
  };
  readonly #emit: (event: { data: string; event: string; id: string }) => void;
  readonly #limitError: (message: string) => Error;

  constructor(
    emit: (event: { data: string; event: string; id: string }) => void,
    lastEventId: string,
    maxLineBytes: number,
    maxEventBytes: number,
    limitError: (message: string) => Error,
  ) {
    this.#handle = new (streams().SseParserNative)(maxLineBytes, maxEventBytes, lastEventId);
    this.#emit = emit;
    this.#limitError = limitError;
    this.lastEventId = lastEventId;
    this.retryMs = undefined;
  }

  feed(text: string): void {
    const outcome = this.#handle.feed(text);
    for (const event of outcome.events) {
      // Dispatch sets the last id before its listener sees the event.
      this.lastEventId = event.id;
      this.#emit(event);
    }
    this.lastEventId = this.#handle.lastEventId();
    this.retryMs = this.#handle.retryMs() ?? undefined;
    if (outcome.error != null) throw this.#limitError(outcome.error);
  }
}

/** `RpcIds` over the native reservations; one handle per pipe, held by `rpc-owner`. */
export class NativeRpcIds {
  readonly #handle: { reserve(id?: RpcIdValue): RpcIdValue };

  constructor(maxExplicit: number) {
    this.#handle = new (streams().RpcIdsNative)(maxExplicit);
  }

  reserve(id?: RpcIdValue): RpcIdValue {
    return this.#handle.reserve(id);
  }
}

interface NativeWrite {
  line: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/**
 * `RpcWriter` over the native bounded FIFO. One write is handed to stdin at a
 * time; the queue's byte bound, the active charge and the cancellation rules are
 * `jsonrpc.rs`'s.
 */
export class NativeRpcWriter {
  readonly #queue: NativeWriterQueue;
  readonly #stream: Writable;
  readonly #writes = new Map<number, NativeWrite>();
  #closed: Error | undefined;

  constructor(stream: Writable, maxQueuedBytes: number) {
    this.#stream = stream;
    this.#queue = new (streams().WriterQueueNative)(maxQueuedBytes);
    stream.on("drain", this.#drain);
    stream.once("close", this.#ended);
    stream.once("error", this.#failed);
  }

  send(line: string, bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(new Error("JSON-RPC write cancelled"));
    let ticket: number;
    try {
      ticket = this.#queue.enqueue(bytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      const write: NativeWrite = {
        line,
        bytes,
        resolve,
        reject,
        cleanup: () => {},
      };
      const abort = () => {
        const queued = this.#queue.cancel(ticket);
        if (queued) this.#writes.delete(ticket);
        write.cleanup();
        write.reject(
          signal?.reason instanceof Error ? signal.reason : new Error("JSON-RPC write cancelled"),
        );
        write.resolve = () => {};
        write.reject = () => {};
      };
      write.cleanup = () => {
        signal?.removeEventListener("abort", abort);
        write.cleanup = () => {};
      };
      this.#writes.set(ticket, write);
      signal?.addEventListener("abort", abort, { once: true });
      this.#pump();
    });
  }

  close(error: Error): void {
    if (this.#closed !== undefined) return;
    this.#closed = error;
    this.#stream.removeListener("drain", this.#drain);
    this.#stream.removeListener("close", this.#ended);
    this.#stream.removeListener("error", this.#failed);
    const active = this.#queue.active();
    const queued = this.#queue.close();
    if (active != null) {
      const write = this.#writes.get(active);
      if (write !== undefined) {
        write.cleanup();
        write.reject(error);
        write.resolve = () => {};
        write.reject = () => {};
      }
    }
    for (const ticket of queued) {
      const write = this.#writes.get(ticket);
      if (write === undefined) continue;
      write.cleanup();
      write.reject(error);
      this.#writes.delete(ticket);
    }
  }

  #drain = (): void => {
    this.#queue.setBlocked(false);
    this.#pump();
  };
  #ended = (): void => {
    this.close(new Error("JSON-RPC stdin closed"));
  };
  #failed = (error: Error): void => {
    this.close(error);
  };
  #pump(): void {
    while (this.#closed === undefined) {
      const ticket = this.#queue.claim();
      if (ticket == null) return;
      const write = this.#writes.get(ticket);
      if (write === undefined) {
        this.#queue.written(ticket);
        continue;
      }
      let blocked: boolean;
      try {
        blocked = !this.#stream.write(write.line, (error?: Error | null) => {
          this.#queue.written(ticket);
          this.#writes.delete(ticket);
          write.cleanup();
          if (error) write.reject(error);
          else write.resolve();
          this.#pump();
        });
      } catch (error) {
        this.#queue.written(ticket);
        this.#writes.delete(ticket);
        write.cleanup();
        write.reject(asError(error));
        continue;
      }
      this.#queue.setBlocked(blocked);
    }
  }
}

/** The wire encodings and classification as `jsonrpc.ts`'s `RpcWire` needs them. */
export function nativeRpcWire() {
  return {
    request(id: RpcIdValue, method: string, params: unknown) {
      const encoded = streams().rpcEncodeRequest(JSON.stringify(id), method, encodedParams(params));
      return { line: encoded.line, bytes: encoded.bytes, message: () => JSON.parse(encoded.line) };
    },
    notification(method: string, params: unknown) {
      const encoded = streams().rpcEncodeNotification(method, encodedParams(params));
      return { line: encoded.line, bytes: encoded.bytes, message: () => JSON.parse(encoded.line) };
    },
    answer(id: RpcIdValue, result: unknown, error: { code: number; message: string } | undefined) {
      const value = error === undefined ? (result ?? null) : undefined;
      const resultJson = error === undefined ? encodedValue(value) : undefined;
      const encoded = streams().rpcEncodeAnswer(
        JSON.stringify(id),
        resultJson,
        error?.code,
        error?.message,
      );
      return { line: encoded.line, bytes: encoded.bytes, message: () => JSON.parse(encoded.line) };
    },
    inspect(line: string, withMessage: boolean) {
      const frame = streams().rpcInspect(line);
      const raw = withMessage && frame.kind !== "unparsable" ? JSON.parse(line) : undefined;
      const id = frame.id ?? undefined;
      const method = frame.method ?? undefined;
      const params = frame.paramsJson == null ? undefined : JSON.parse(frame.paramsJson);
      const result = frame.resultJson == null ? undefined : JSON.parse(frame.resultJson);
      const error = frame.error ?? undefined;
      switch (frame.kind) {
        case "request":
          if (id === undefined || method === undefined) return { kind: "malformed" as const, raw };
          return { kind: "request" as const, raw, id, method, params };
        case "notification":
          if (method === undefined) return { kind: "malformed" as const, raw };
          return { kind: "notification" as const, raw, method, params };
        case "response":
          if (id === undefined) return { kind: "malformed" as const, raw };
          return { kind: "response" as const, raw, id, result, error };
        case "malformed":
          return { kind: "malformed" as const, raw };
        default:
          return { kind: "unparsable" as const, raw: undefined };
      }
    },
  };
}

/** `JSON.stringify(params)`, omitted when it would write nothing (as today). */
function encodedParams(params: unknown): string | undefined {
  if (params === undefined) return undefined;
  return encodedValue(params);
}

function encodedValue(value: unknown): string | undefined {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : json;
}

/** `rpcErrorCode`'s native half. */
export function nativeRpcErrorCode(message: string): number | undefined {
  return streams().rpcErrorCode(message) ?? undefined;
}
