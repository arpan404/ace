// SPDX-License-Identifier: Apache-2.0
/** The native line, gate, JSONL and dropped-line shells: I/O stays here. */

import { createInterface, type Interface } from "node:readline";
import { PassThrough, Transform, type Readable } from "node:stream";
import {
  asError,
  type FramedLines,
  type NativeDroppedLine,
  type NativeFramedPart,
  restoreLine,
  streams,
} from "./native-stream-addon.ts";

/** `byteLimit`: a positive safe integer, or the RangeError it threw. */
export function nativeByteLimit(value: number, name: string): number {
  return streams().streamByteLimit(value, name);
}

/** The lines of one crossing, or undefined when it held none. */
function splitLines(out: FramedLines): string[] | undefined {
  return out.count === 0 ? undefined : out.text.split("\n");
}

/**
 * `lineReader`: one native framer per pipe, readline still delivering the lines
 * (pause, resume and async iteration stay node's). The input is resumed only when
 * no line is held and the flow guard is clear, so neither a paused consumer nor a
 * full owner is read past.
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
          void flow.wait().then(() => {
            if (failure !== undefined) return;
            state.unblock();
            drain();
          }, failed);
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
      const batch = splitLines(framer.finish());
      if (batch !== undefined) pending.push(...batch);
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
      const batch = splitLines(framer.push(bytes));
      if (batch !== undefined) pending.push(...batch);
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
    const lines = splitLines(outcome.lines);
    if (lines !== undefined) pending.push(...lines);
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
