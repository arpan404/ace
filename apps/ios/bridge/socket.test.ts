import { native } from "./test-host.ts";
import { expect, test } from "vitest";
import { nativeMediaSocket, nativeTransport, socketEvent } from "./socket.ts";

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

test("a paired socket hears only Swift's verdict on its own standing proof", () => {
  let id = "";
  native.socket = (socket, action) => {
    if (action === "open") id = socket;
  };
  const heard: (string | undefined)[] = [];
  const messages: string[] = [];
  const transport = nativeTransport(undefined, undefined, (standing) => heard.push(standing));
  transport.open({ open() {}, message: (text) => messages.push(text), close() {} });
  socketEvent(id, "standing", "proven");
  socketEvent(id, "standing", "missing");
  // Anything else Swift could say is no verdict; the SDK never sees any of it as a message.
  socketEvent(id, "standing", "person");
  expect(heard).toEqual(["proven", "missing"]);
  expect(messages).toEqual([]);
  socketEvent(id, "close", "1006");
  // Once closed, a late verdict from that socket is heard by no one.
  socketEvent(id, "standing", "proven");
  expect(heard).toEqual(["proven", "missing", undefined]);
});

test("a socket's standing is cleared when Swift says it ran out and when the socket closes", () => {
  let id = "";
  native.socket = (socket, action) => {
    if (action === "open") id = socket;
  };
  const heard: (string | undefined)[] = [];
  const transport = nativeTransport(undefined, undefined, (standing) => heard.push(standing));
  transport.open({ open() {}, message() {}, close() {} });
  socketEvent(id, "standing", "proven");
  // The daemon's expiry passed with no fresh proof: Swift clears what the script was told.
  socketEvent(id, "standing", "cleared");
  socketEvent(id, "standing", "proven");
  // A reconnect starts unproven: the old socket's verdict is not carried to the next.
  socketEvent(id, "close", "1006");
  expect(heard).toEqual(["proven", undefined, "proven", undefined]);
});

test("a media connection opens natively at its address, sends its hello as bytes and hears text", () => {
  const asked: [string, string, string][] = [];
  native.socket = (id, action, value) => asked.push([id, action, value]);
  const heard: string[] = [];
  const socket = nativeMediaSocket("wss://studio.local:4612/media");
  socket.open({ open() {}, message: (text) => heard.push(text), close() {} });
  const hello = Uint8Array.from([0x41, 0x43, 0x45, 0x43, 1, 0, 255, 128]);
  socket.sendBytes(hello);
  socket.send('{"type":"ping"}');

  const [[id, open, opening], [, bytes, sent], [, text]] = asked as [
    [string, string, string],
    [string, string, string],
    [string, string, string],
  ];
  expect([open, JSON.parse(opening)]).toEqual([
    "open",
    { media: { url: "wss://studio.local:4612/media" } },
  ]);
  expect(bytes).toBe("bytes");
  expect(Uint8Array.from(Buffer.from(sent, "base64"))).toEqual(hello);
  expect(text).toBe("send");
  socketEvent(id, "message", '{"type":"media.welcome","connection":"mc_abcdefgh"}');
  expect(heard).toEqual(['{"type":"media.welcome","connection":"mc_abcdefgh"}']);
});

test("a media connection without an address asks native code for the relay's media stream", () => {
  const asked: string[] = [];
  native.socket = (_id, action, value) => {
    if (action === "open") asked.push(value);
  };
  nativeMediaSocket(undefined).open({ open() {}, message() {}, close() {} });
  expect(asked.map((value) => JSON.parse(value))).toEqual([{ media: {} }]);
});
