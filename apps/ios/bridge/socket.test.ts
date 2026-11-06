import { native } from "./test-host.ts";
import { expect, test } from "vitest";
import { nativeTransport, socketEvent } from "./socket.ts";

/** Open a native transport and return what its close reported. */
function opened() {
  let id = "";
  native.socket = (socket, action) => {
    if (action === "open") id = socket;
  };
  const closes: [number, string | undefined][] = [];
  nativeTransport().open({
    open() {},
    message() {},
    close: (code, reason) => closes.push([code, reason]),
  });
  return { id: () => id, closes };
}

test("a native close keeps the daemon's reason, so the owner's revocation is told apart", () => {
  const socket = opened();
  socketEvent(socket.id(), "close", "4003 Device revoked");
  expect(socket.closes).toEqual([[4003, "Device revoked"]]);
});

test("a native close with only a code reaches the client without a reason", () => {
  const socket = opened();
  socketEvent(socket.id(), "close", "4003");
  expect(socket.closes).toEqual([[4003, undefined]]);
});
