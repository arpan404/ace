import { describe, expect, it } from "vitest";
import { connectReply, greetingReply, parseConnect, parseGreeting, socksReply } from "./socks5.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const domain = (name: string, port: number) =>
  bytes(
    5,
    1,
    0,
    3,
    name.length,
    ...Array.from(name, (c) => c.charCodeAt(0)),
    port >> 8,
    port & 255,
  );

describe("SOCKS5 greeting", () => {
  it.each([
    ["offers no authentication", bytes(5, 1, 0), { kind: "ok", length: 3, noAuth: true }],
    ["offers it among others", bytes(5, 2, 2, 0), { kind: "ok", length: 4, noAuth: true }],
    ["offers only a password", bytes(5, 1, 2), { kind: "ok", length: 3, noAuth: false }],
    ["is cut short", bytes(5, 2, 0), { kind: "more" }],
    ["is empty", bytes(5), { kind: "more" }],
    ["is SOCKS4", bytes(4, 1, 0), { kind: "invalid" }],
    ["offers no method", bytes(5, 0), { kind: "invalid" }],
  ])("a greeting that %s", (_name, input, expected) => {
    expect(parseGreeting(input)).toEqual(expected);
  });

  it("answers no authentication, or no acceptable method", () => {
    expect(Array.from(greetingReply(true))).toEqual([5, 0]);
    expect(Array.from(greetingReply(false))).toEqual([5, 0xff]);
  });
});

describe("SOCKS5 CONNECT", () => {
  it.each([
    ["localhost by name", domain("localhost", 3000), { host: "localhost", port: 3000 }],
    [
      "a name in capitals, lowered",
      domain("App.LOCALHOST", 5173),
      { host: "app.localhost", port: 5173 },
    ],
    [
      "an IPv4 address",
      bytes(5, 1, 0, 1, 127, 0, 0, 1, 0x1f, 0x90),
      { host: "127.0.0.1", port: 8080 },
    ],
    [
      "IPv6 loopback",
      bytes(5, 1, 0, 4, ...Array.from({ length: 15 }, () => 0), 1, 0x0b, 0xb8),
      { host: "[::1]", port: 3000 },
    ],
    [
      "a full IPv6 address",
      bytes(5, 1, 0, 4, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 80),
      { host: "[2001:db8::1]", port: 80 },
    ],
  ])("reads %s", (_name, input, expected) => {
    const parsed = parseConnect(input);
    expect(parsed).toEqual({ kind: "ok", length: input.length, ...expected });
  });

  it("leaves bytes sent after the request for the stream", () => {
    const request = domain("localhost", 3000);
    const parsed = parseConnect(Uint8Array.from([...request, 71, 69, 84]));
    expect(parsed).toMatchObject({ kind: "ok", length: request.length });
  });

  it.each([
    ["the header", bytes(5, 1, 0)],
    ["a name", domain("localhost", 3000).subarray(0, 8)],
    ["an IPv4 port", bytes(5, 1, 0, 1, 127, 0, 0, 1, 0)],
    ["an IPv6 address", bytes(5, 1, 0, 4, 0, 0)],
  ])("waits for the rest of %s", (_name, input) => {
    expect(parseConnect(input)).toEqual({ kind: "more" });
  });

  it.each([
    ["BIND", bytes(5, 2, 0, 1, 127, 0, 0, 1, 0, 80), socksReply.commandNotSupported],
    ["UDP ASSOCIATE", bytes(5, 3, 0, 3, 1, 97, 0, 80), socksReply.commandNotSupported],
    ["an unknown address type", bytes(5, 1, 0, 9, 0, 0), socksReply.addressTypeNotSupported],
    ["an empty name", bytes(5, 1, 0, 3, 0, 0, 80), socksReply.hostUnreachable],
    ["port 0", bytes(5, 1, 0, 1, 127, 0, 0, 1, 0, 0), socksReply.hostUnreachable],
  ])("refuses %s", (_name, input, reply) => {
    expect(parseConnect(input)).toEqual({ kind: "invalid", reply });
  });

  it("refuses a request that isn't SOCKS5", () => {
    expect(parseConnect(bytes(4, 1, 0, 1, 127, 0, 0, 1, 0, 80))).toEqual({ kind: "invalid" });
  });

  it("replies with the code and an empty bound address", () => {
    expect(Array.from(connectReply(socksReply.notAllowed))).toEqual([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
  });
});
