/*
 * The few SOCKS5 messages (RFC 1928) Chromium sends a proxy for a machine's localhost: the
 * method greeting and one CONNECT. Pure: bytes in, a parsed message or a refusal out. No
 * authentication and no other command is offered.
 */

/** Reply codes from RFC 1928 §6 that this proxy sends. */
export const socksReply = {
  succeeded: 0x00,
  generalFailure: 0x01,
  notAllowed: 0x02,
  networkUnreachable: 0x03,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08,
} as const;
export type SocksReplyCode = (typeof socksReply)[keyof typeof socksReply];

/** A parse that needs more bytes, failed, or read a message of `length` bytes. */
export type Parsed<T> =
  | { kind: "more" }
  | { kind: "invalid"; reply?: SocksReplyCode }
  | ({ kind: "ok"; length: number } & T);

const version = 0x05;
const noAuthentication = 0x00;
const noAcceptableMethod = 0xff;

/** `VER NMETHODS METHODS…`: accepted only when it offers "no authentication". */
export function parseGreeting(bytes: Uint8Array): Parsed<{ noAuth: boolean }> {
  if (bytes.length < 2) return { kind: "more" };
  if (bytes[0] !== version) return { kind: "invalid" };
  const count = bytes[1] ?? 0;
  if (count === 0) return { kind: "invalid" };
  if (bytes.length < 2 + count) return { kind: "more" };
  const methods = bytes.subarray(2, 2 + count);
  return { kind: "ok", length: 2 + count, noAuth: methods.includes(noAuthentication) };
}

/** The method choice: no authentication, or none acceptable. */
export function greetingReply(noAuth: boolean): Uint8Array {
  return Uint8Array.of(version, noAuth ? noAuthentication : noAcceptableMethod);
}

/**
 * `VER CMD RSV ATYP DST.ADDR DST.PORT`. Only CONNECT is taken. The host is kept as Chromium
 * named it: a domain unresolved, an IPv4 address dotted, an IPv6 address in brackets, so the
 * caller judges the name the page used.
 */
export function parseConnect(bytes: Uint8Array): Parsed<{ host: string; port: number }> {
  if (bytes.length < 4) return { kind: "more" };
  if (bytes[0] !== version || bytes[2] !== 0x00) return { kind: "invalid" };
  const command = bytes[1];
  const type = bytes[3];
  let host: string;
  let at: number;
  if (type === 0x01) {
    if (bytes.length < 4 + 4 + 2) return { kind: "more" };
    host = Array.from(bytes.subarray(4, 8)).join(".");
    at = 8;
  } else if (type === 0x03) {
    if (bytes.length < 5) return { kind: "more" };
    const length = bytes[4] ?? 0;
    if (length === 0) return { kind: "invalid", reply: socksReply.hostUnreachable };
    if (bytes.length < 5 + length + 2) return { kind: "more" };
    host = new TextDecoder("latin1").decode(bytes.subarray(5, 5 + length)).toLowerCase();
    at = 5 + length;
  } else if (type === 0x04) {
    if (bytes.length < 4 + 16 + 2) return { kind: "more" };
    host = `[${ipv6(bytes.subarray(4, 20))}]`;
    at = 20;
  } else return { kind: "invalid", reply: socksReply.addressTypeNotSupported };
  if (command !== 0x01) return { kind: "invalid", reply: socksReply.commandNotSupported };
  const port = ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  if (port === 0) return { kind: "invalid", reply: socksReply.hostUnreachable };
  return { kind: "ok", length: at + 2, host, port };
}

/** The answer to a CONNECT. The bound address is never meaningful here: 0.0.0.0:0. */
export function connectReply(code: SocksReplyCode): Uint8Array {
  return Uint8Array.of(version, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0);
}

const hex = (list: number[]) => list.map((group) => group.toString(16)).join(":");

/** Sixteen bytes as an IPv6 address, the longest run of zero groups folded to `::`. */
function ipv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2)
    groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8;) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > best.length && end - start > 1) best = { start, length: end - start };
    start = end;
  }
  if (best.start < 0) return hex(groups);
  return `${hex(groups.slice(0, best.start))}::${hex(groups.slice(best.start + best.length))}`;
}
