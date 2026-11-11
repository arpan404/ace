/*
 * Whether a URL reaches the machine itself or its local network: loopback, link-local,
 * private, carrier-grade NAT, unspecified and multicast addresses, `localhost` names, and
 * hostnames that resolve to any of those. Sessions an outside MCP client drives (ADR 0117) are
 * kept off them; ace's own agents are not.
 */
import { isIP } from "node:net";

/** Every address a hostname resolves to; the daemon passes `dns.lookup` with `all`. */
export type ResolveHost = (host: string) => Promise<readonly string[]>;

function v4(address: string): number[] | undefined {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part)) ? parts : undefined;
}
function privateV4([a = 0, b = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function hexGroups(half: string | undefined): number[] {
  return half ? half.split(":").map((group) => Number.parseInt(group, 16)) : [];
}
/** An IPv6 address as its eight 16-bit groups, embedded dotted IPv4 included. */
function groups(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const parts = v4(dotted);
    if (!parts) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = parts;
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = hexGroups(halves[0]);
  const tail = hexGroups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const all = [...head, ...Array<number>(Math.max(0, missing)).fill(0), ...tail];
  return all.length === 8 && all.every((group) => group >= 0 && group <= 0xffff) ? all : undefined;
}
/** The IPv4 address in the low 32 bits. */
function low32(all: number[]): number[] {
  const high = all[6] ?? 0;
  const low = all[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}
const zero = (all: number[], from: number, to: number) =>
  all.slice(from, to).every((group) => group === 0);

/**
 * Whether an IPv6 address is on this machine or its local network. An address that carries an
 * IPv4 address (mapped, translated, compatible, NAT64, 6to4) is judged as that address.
 */
function privateV6(address: string): boolean {
  const all = groups(address);
  if (!all) return true;
  const [first = 0, second = 0] = all;
  // ::, ::1
  if (zero(all, 0, 7) && (all[7] ?? 0) <= 1) return true;
  // ::ffff:a.b.c.d (mapped), ::ffff:0:a.b.c.d (translated), ::a.b.c.d (compatible)
  if (zero(all, 0, 5) && all[5] === 0xffff) return privateV4(low32(all));
  if (zero(all, 0, 4) && all[4] === 0xffff && all[5] === 0) return privateV4(low32(all));
  if (zero(all, 0, 6)) return privateV4(low32(all));
  // 64:ff9b::/96 well-known NAT64 reaches the IPv4 address it carries; 64:ff9b:1::/48 is local.
  if (first === 0x64 && second === 0xff9b && zero(all, 2, 6)) return privateV4(low32(all));
  if (first === 0x64 && second === 0xff9b && all[2] === 1) return true;
  // 2002::/16 6to4 carries its IPv4 address in the next 32 bits.
  if (first === 0x2002) {
    const g1 = all[1] ?? 0;
    const g2 = all[2] ?? 0;
    return privateV4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}
/** Whether an IP address is on this machine or its local network. */
export function privateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = v4(address);
    return !parts || privateV4(parts);
  }
  return kind === 6 ? privateV6(address) : true;
}

/**
 * Whether `url` would reach this machine or its local network. A hostname that doesn't
 * resolve is treated as reaching it: what can't be checked is refused.
 */
export async function reachesPrivateNetwork(url: string, resolve: ResolveHost): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  // Only network URLs go anywhere; the origin policy decides the rest (about:blank, data:).
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host)) return privateAddress(host);
  try {
    const addresses = await resolve(host);
    return addresses.length === 0 || addresses.some(privateAddress);
  } catch {
    return true;
  }
}
