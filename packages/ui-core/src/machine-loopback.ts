/*
 * Which hostnames a device tab sends to its machine (ADR 0194): the loopback names, which the
 * tunnel carries to the machine's own loopback. Every other host connects straight from the
 * device. Pure; nothing is resolved.
 */

const ipv4Loopback =
  /^127\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){2}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Whether `hostname` names the machine's loopback: `localhost`, any `*.localhost`, an address in
 * `127.0.0.0/8`, or `::1` (bare or bracketed, as `URL.hostname` gives it). Case does not matter,
 * and one trailing dot (`localhost.`) is the same name.
 */
export function isMachineLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) {
    // Each label of a `*.localhost` name must be non-empty: `.localhost` alone is not a name.
    return host.split(".").every((label) => label.length > 0);
  }
  if (ipv4Loopback.test(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return isIpv6Loopback(host);
}

const groups = (part: string | undefined) => (part ? part.split(":") : []);

/** `::1` in any of its spellings (`0:0:0:0:0:0:0:1`, `::0:1`), never a zone or a mapped IPv4. */
function isIpv6Loopback(host: string): boolean {
  if (!/^[\da-f:]+$/.test(host) || !host.includes(":")) return false;
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if ([...head, ...tail].some((group) => group.length === 0 || group.length > 4)) return false;
  const count = head.length + tail.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return false;
  const all = [...head, ...Array<string>(8 - count).fill("0"), ...tail];
  return all.every((group, index) => Number.parseInt(group, 16) === (index === 7 ? 1 : 0));
}
