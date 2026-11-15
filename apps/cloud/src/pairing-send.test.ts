import { expect, it } from "vitest";
import { sendPairing } from "./pairing-send.ts";

// The hosted relay's pairing (ADR 0155): the marker to the client, then the held first-flight
// frame to the daemon. Whatever a send does, the held frame is wiped when this returns.

const held = () => new Uint8Array(40).fill(7);
const wiped = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);
const throwing = () => {
  throw new Error("Socket failed");
};

it("forwarded: the daemon gets the bytes, then the held frame is wiped", () => {
  const frame = held();
  const sent: number[][] = [];
  expect(
    sendPairing({ send: () => {} }, { send: (bytes) => sent.push([...bytes]) }, 2, frame),
  ).toBe("forwarded");
  expect(sent).toEqual([Array.from({ length: 40 }, () => 7)]);
  expect(wiped(frame)).toBe(true);
});

it.each([
  ["the marker's send", throwing, () => {}],
  ["the frame's send", () => {}, throwing],
])("when %s throws, the held frame is wiped all the same", (_name, client, host) => {
  const frame = held();
  expect(() => sendPairing({ send: client }, { send: host }, 2, frame)).toThrow();
  expect(wiped(frame)).toBe(true);
});
