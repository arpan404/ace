/*
 * The daemon's own fetch of a client metadata document (ADR 0117): HTTPS on port 443 to a
 * public address only, with no redirects, a size cap and a time limit. The host is resolved
 * once and the connection goes to that address (with the name for TLS), so a name that changes
 * its answer between the check and the request can't reach this machine or its network. The
 * address rule is the one outside browser sessions use.
 */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { privateAddress, type ResolveHost } from "@ace/browser/private-network";
import { metadataMaxBytes, type MetadataFetch } from "./cimd.ts";

export const systemResolve: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** `work`, or a rejection as soon as `signal` aborts. */
function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolved, rejected) => {
    const abort = () => rejected(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolved, rejected).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function publicMetadataFetch(resolve: ResolveHost = systemResolve): MetadataFetch {
  return async (url, signal) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // The lookup is under the same deadline as the request.
    const addresses = isIP(host) ? [host] : await beforeAbort(resolve(host), signal);
    const address = addresses[0];
    if (address === undefined || addresses.some(privateAddress))
      throw new Error("Client metadata host is not public");
    return new Promise((resolved, rejected) => {
      const outgoing = request(
        {
          host: address,
          servername: isIP(host) ? undefined : host,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { host: url.host, accept: "application/json" },
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let tooLarge = false;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > metadataMaxBytes) {
              tooLarge = true;
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", rejected);
          response.on("close", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers))
              if (typeof value === "string") headers.set(name, value);
            resolved({
              status: response.statusCode ?? 0,
              headers,
              // Over the cap, the document is refused as too large, never read in part.
              body: tooLarge
                ? new Uint8Array(metadataMaxBytes + 1)
                : new Uint8Array(Buffer.concat(chunks)),
            });
          });
        },
      );
      outgoing.on("error", rejected);
      outgoing.end();
    });
  };
}
