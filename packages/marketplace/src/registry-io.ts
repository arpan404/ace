import { registryProofHeader, signRegistryRequest } from "./registry.ts";
import type { SignerIo } from "./signer-io.ts";
import type { MarketSigningKey } from "./signing.ts";

/*
 * The org signer's I/O (ADR 0206 §5.2): the market signer's core (`signPending`) run against one
 * organization's registry. Its `/v1/signer/…` paths become `/v1/orgs/{org}/signer/…`, and every
 * request carries a proof made with the registry's current key, its only credential.
 */

export type RegistryFetch = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export function registrySignerIo(input: {
  org: string;
  key: MarketSigningKey;
  now: () => number;
  fetch: RegistryFetch;
}): SignerIo {
  const mapped = (path: string) =>
    path.startsWith("/v1/signer/")
      ? `/v1/orgs/${input.org}/signer/${path.slice("/v1/signer/".length)}`
      : path;
  const send = (method: string, path: string, body?: string) => {
    const target = mapped(path);
    const pathname = new URL(target, "http://market").pathname;
    const proof = signRegistryRequest(input.key, {
      method,
      path: pathname,
      at: input.now(),
      ...(body === undefined ? {} : { body: new TextEncoder().encode(body) }),
    });
    const headers: Record<string, string> = { [registryProofHeader]: proof };
    if (body !== undefined) headers["content-type"] = "application/json";
    return input.fetch(target, { method, headers, ...(body === undefined ? {} : { body }) });
  };
  const ok = async (response: Response, path: string) => {
    if (!response.ok) throw new Error(`The market answered ${response.status} for ${path}`);
    return response;
  };
  return {
    get: async (path) => (await ok(await send("GET", path), path)).json(),
    read: async (path) => {
      const response = await send("GET", path);
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      return (await ok(response, path)).json();
    },
    object: async (hash) => {
      const path = `/v1/signer/objects/${hash}`;
      return new Uint8Array(await (await ok(await send("GET", path), path)).arrayBuffer());
    },
    put: async (path, body) => {
      const response = await send("PUT", path, JSON.stringify(body));
      return { status: response.status, text: await response.text() };
    },
  };
}
