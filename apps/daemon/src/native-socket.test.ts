// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from "vitest";
import type { NativeSocketEvent, NativeSocketHandle } from "@ace/provider-kit/native-transport";
import { NativeSocket } from "./native-socket.ts";

/** A socket handle that records what the shell asked it to do. */
function handle(
  closed: (code: number | null, reason: string) => void,
  listening?: (events: (event: NativeSocketEvent) => void) => void,
): NativeSocketHandle {
  return {
    listen(events) {
      listening?.(events);
    },
    send() {
      return "queued";
    },
    close: closed,
    terminate() {},
    pause() {},
    resume() {},
    isPaused() {
      return false;
    },
    bufferedAmount() {
      return 0;
    },
    readyState() {
      return 1;
    },
  };
}

test("a local close refuses ws's invalid code and over-long reason before the wire", () => {
  const close = vi.fn();
  const socket = new NativeSocket(handle(close));

  expect(() => socket.close(1005)).toThrow(TypeError);
  expect(() => socket.close(1005)).toThrow("First argument must be a valid error code number");
  expect(() => socket.close(5000)).toThrow(TypeError);
  expect(() => socket.close(1000, "x".repeat(124))).toThrow(RangeError);
  expect(() => socket.close(1000, "x".repeat(124))).toThrow(
    "The message must not be greater than 123 bytes",
  );
  expect(close).not.toHaveBeenCalled();

  socket.close(1000, "x".repeat(123));
  expect(close).toHaveBeenCalledWith(1000, "x".repeat(123));
});

test("a close on a closing or closed socket returns before validating, as ws does", () => {
  let receive: ((event: NativeSocketEvent) => void) | undefined;
  const close = vi.fn();
  const socket = new NativeSocket(
    handle(close, (events) => {
      receive = events;
    }),
  );

  socket.terminate();
  expect(() => socket.close(1005)).not.toThrow(TypeError);
  expect(() => socket.close(1000, "x".repeat(124))).not.toThrow(RangeError);
  expect(close).not.toHaveBeenCalled();

  receive?.({ kind: "close", code: 1000, reason: Buffer.alloc(0) });
  expect(() => socket.close(1005)).not.toThrow(TypeError);
  expect(close).not.toHaveBeenCalled();
});
