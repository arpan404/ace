import { DeviceCredential, SocketTicket } from "@ace/protocol";
import { ClientError } from "./types.ts";

export interface AccessOptions {
  origin: string;
  /** Transport owns trusted TLS/pinning. Browsers require a trusted HTTPS certificate. */
  fetch(input: string, init: RequestInit): Promise<Response>;
  token(): Promise<string>;
}

/** The daemon's access origin: trusted HTTPS, or plain HTTP only on local loopback. */
export function accessOrigin(origin: string): string {
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new ClientError("auth", "Trusted HTTPS or local loopback required");
  return url.origin;
}

/** One HTTP access call: never redirected, never cached, its JSON reply capped at 1 MiB. */
export async function accessCall(
  options: AccessOptions,
  path: string,
  method: string,
  value?: unknown,
  authenticate = true,
  signal?: AbortSignal,
): Promise<unknown> {
  const token = authenticate
    ? DeviceCredential.shape.token.parse(await options.token())
    : undefined;
  const response = await options.fetch(accessOrigin(options.origin) + path, {
    method,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(value === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ClientError("daemon", `HTTP ${response.status}`);
  }
  if (!response.body) throw new ClientError("protocol");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) {
        await reader.cancel();
        throw new ClientError("limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const result: unknown = JSON.parse(text);
    return result;
  } finally {
    reader.releaseLock();
  }
}

/** A one-use socket ticket for a paired device, without the rest of the access API. */
export async function socketTicket(options: AccessOptions, signal?: AbortSignal) {
  return SocketTicket.parse(
    await accessCall(options, "/v1/tickets", "POST", undefined, true, signal),
  );
}
