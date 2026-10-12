import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/*
 * A GET of a public web resource, and nothing else: the daemon fetches site icons on the
 * person's own machine, so a request must never reach loopback, the local network, link-local
 * metadata services or anything else that is not the public internet (no request forgery).
 * Every address a host name resolves to is checked, the connection is pinned to a checked
 * address, and redirects are followed by hand so each hop is checked again. No cookies,
 * credentials or referrer; a short timeout and a byte cap.
 */

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-mapped and translated forms would reach the IPv4 ranges above by another name.
  ["::ffff:0:0", 96],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

/** Whether an address is on the public internet: not loopback, private, link-local or special. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Where a request may connect. The default: public addresses on the standard web ports. */
export type AddressPolicy = (address: string, port: number) => boolean;
export const publicWeb: AddressPolicy = (address, port) =>
  isPublicAddress(address) && (port === 80 || port === 443);

export interface PublicFetchOptions {
  /** Every address of a host name. Injected so tests and platforms can stand in for DNS. */
  resolve?: (host: string) => Promise<string[]>;
  allowed?: AddressPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
}

export type PublicResponse =
  | { kind: "ok"; body: Buffer; contentType: string; url: string }
  | { kind: "missing" }
  | { kind: "refused" }
  | { kind: "failed" };

const systemResolve = async (host: string) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

class Refused extends Error {}

/** A lookup that answers only with checked addresses; any unchecked answer refuses the host. */
function pinnedLookup(
  resolve: (host: string) => Promise<string[]>,
  allowed: AddressPolicy,
  port: number,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        // A host that also names a private address is refused outright (DNS rebinding).
        if (!addresses.length || !addresses.every((address) => allowed(address, port))) {
          callback(new Refused(`refused ${hostname}`), "", 4);
          return;
        }
        const entries = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) callback(null, entries);
        else callback(null, entries[0]?.address ?? "", entries[0]?.family ?? 4);
      },
      (error: Error) => callback(error, "", 4),
    );
  };
}

function once(url: URL, options: Required<PublicFetchOptions>): Promise<IncomingMessage> {
  const port = portOf(url);
  const literal = isIP(url.hostname.replace(/^\[|\]$/g, ""));
  if (literal && !options.allowed(url.hostname.replace(/^\[|\]$/g, ""), port))
    return Promise.reject(new Refused(`refused ${url.hostname}`));
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pinnedLookup(options.resolve, options.allowed, port),
        timeout: options.timeoutMs,
        headers: { accept: options.accept, "user-agent": "ace", "accept-encoding": "identity" },
      },
      resolve,
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("timeout")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function body(response: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) {
    response.destroy();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += part.length;
    if (total > max) {
      response.destroy();
      return undefined;
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

/**
 * GET `url` from the public web. `missing` when it isn't there (4xx, too large, no body),
 * `refused` when it would leave the public web, `failed` when it may work later.
 */
export async function publicGet(
  url: string,
  input: PublicFetchOptions = {},
): Promise<PublicResponse> {
  const options: Required<PublicFetchOptions> = {
    resolve: systemResolve,
    allowed: publicWeb,
    timeoutMs: 3000,
    maxBytes: 256 * 1024,
    maxRedirects: 3,
    accept: "image/*",
    ...input,
  };
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { kind: "missing" };
  }
  const deadline = AbortSignal.timeout(options.timeoutMs * (options.maxRedirects + 1));
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    if (deadline.aborted) return { kind: "failed" };
    if (current.protocol !== "https:" && current.protocol !== "http:") return { kind: "refused" };
    if (current.username || current.password) return { kind: "refused" };
    let response: IncomingMessage;
    try {
      response = await once(current, options);
    } catch (error) {
      return error instanceof Refused ? { kind: "refused" } : { kind: "failed" };
    }
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      try {
        current = new URL(response.headers.location, current);
      } catch {
        return { kind: "missing" };
      }
      continue;
    }
    if (status >= 500 || status === 429) {
      response.resume();
      return { kind: "failed" };
    }
    if (status < 200 || status >= 300) {
      response.resume();
      return { kind: "missing" };
    }
    try {
      const bytes = await body(response, options.maxBytes);
      if (!bytes?.length) return { kind: "missing" };
      return {
        kind: "ok",
        body: bytes,
        contentType: String(response.headers["content-type"] ?? ""),
        url: current.href,
      };
    } catch {
      return { kind: "failed" };
    }
  }
  return { kind: "missing" };
}
