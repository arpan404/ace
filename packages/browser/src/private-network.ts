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

/** Whether an IP address is on this machine or its local network. */
export function privateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = v4(address);
    return !parts || privateV4(parts);
  }
  if (kind !== 6) return true;
  const lower = address.toLowerCase();
  // An IPv4 address carried in IPv6 (::ffff:127.0.0.1) is judged as that address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return privateAddress(mapped);
  // URLs write it in hex: [::ffff:10.0.0.1] becomes [::ffff:a00:1].
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = Number.parseInt(hex[1] ?? "0", 16);
    const low = Number.parseInt(hex[2] ?? "0", 16);
    return privateV4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  if (lower === "::" || lower === "::1") return true;
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
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
