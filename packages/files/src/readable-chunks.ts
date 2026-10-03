import type { Readable } from "node:stream";
import { FileError } from "./types.ts";

/** Pause after one data event. Unlike async stream iteration, this never concatenates chunks. */
export function readChunks(stream: Readable) {
  let ended = false;
  let failure: unknown;
  let waiting:
    | ReturnType<typeof Promise.withResolvers<IteratorResult<Buffer, undefined>>>
    | undefined;
  stream.pause();
  const fail = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error;
    waiting?.reject(error);
    waiting = undefined;
  };
  const data = (input: unknown) => {
    stream.pause();
    const pending = waiting;
    waiting = undefined;
    if (!pending) {
      stream.destroy(new FileError("QUOTA", "Unrequested archive chunk"));
      return;
    }
    if (Buffer.isBuffer(input)) pending.resolve({ done: false, value: input });
    else {
      const error = new FileError("IO_ERROR", "Archive stream returned nonbinary data");
      pending.reject(error);
      stream.destroy(error);
    }
  };
  const end = () => {
    ended = true;
    waiting?.resolve({ done: true, value: undefined });
    waiting = undefined;
  };
  const close = () => {
    if (!ended) fail(new FileError("ABORTED", "Archive stream closed"));
  };
  stream.on("data", data);
  stream.on("end", end);
  stream.on("error", fail);
  stream.on("close", close);
  return {
    async next(): Promise<IteratorResult<Buffer, undefined>> {
      if (failure !== undefined) throw failure;
      if (ended) return { done: true, value: undefined };
      if (waiting) throw new FileError("BUSY", "Concurrent archive read");
      const pending = Promise.withResolvers<IteratorResult<Buffer, undefined>>();
      waiting = pending;
      stream.resume();
      return pending.promise;
    },
    dispose() {
      stream.off("data", data);
      stream.off("end", end);
      stream.off("error", fail);
      stream.off("close", close);
    },
  };
}
