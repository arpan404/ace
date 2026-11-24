// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from "vitest";
import type { NativeSocketHandle } from "@ace/provider-kit/native-transport";
import { NativeSocket } from "./native-socket.ts";

/** A socket handle that records what the shell asked it to do. */
function handle(closed: (code: number | null, reason: string) => void): NativeSocketHandle {
  return {
    listen() {},
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
