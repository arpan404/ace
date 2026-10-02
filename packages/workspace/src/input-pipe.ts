import { closeSync } from "node:fs";
import { Socket } from "node:net";
import { pipeDescriptors } from "./descriptor.ts";

/** A real POSIX pipe can be reopened via /dev/fd on Linux as well as macOS. */
export function inputPipe() {
  const pair = pipeDescriptors();
  let stream: Socket;
  try {
    stream = new Socket({ fd: pair.write, readable: false, writable: true });
  } catch (error) {
    closeSync(pair.read);
    closeSync(pair.write);
    throw error;
  }
  let readerOpen = true;
  function releaseReader() {
    if (!readerOpen) return;
    readerOpen = false;
    closeSync(pair.read);
  }
  return {
    fd: pair.read,
    stream,
    releaseReader,
    async dispose() {
      releaseReader();
      if (stream.closed) return;
      const closed = new Promise<void>((resolve) => stream.once("close", resolve));
      stream.destroy();
      await closed;
    },
  };
}
export type InputPipe = ReturnType<typeof inputPipe>;
