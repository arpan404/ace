import { DeviceToken } from "@ace/protocol";
import { ClientError } from "./types.ts";

function scheduleTimeout(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

export interface AccessOptions {
  origin: string;
  /** Transport owns trusted TLS/pinning. Browsers require a trusted HTTPS certificate. */
  fetch(input: string, init: RequestInit): Promise<Response>;
  token(): Promise<string>;
  timeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}
export interface AccessHttp {
  (
    path: string,
    method: string,
    value?: unknown,
    authenticate?: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Bounded HTTP transport shared by access operations and single-use ticket exchange. */
export function accessHttp(options: AccessOptions): AccessHttp {
  const url = new URL(options.origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new ClientError("auth", "Trusted HTTPS or local loopback required");
  const origin = url.origin;
  async function call(
    path: string,
    method: string,
    value?: unknown,
    authenticate = true,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const schedule = options.schedule ?? scheduleTimeout;
    let cancel: (() => void) | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      cancel = schedule(() => {
        controller.abort();
        reject(
          new ClientError(
            "offline",
            "This computer didn't respond. Check the connection and try again.",
          ),
        );
      }, options.timeoutMs ?? 15000);
    });
    try {
      return await Promise.race([
        callRaw(
          path,
          method,
          value,
          authenticate,
          signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        ),
        timedOut,
      ]);
    } catch (error) {
      throw error instanceof ClientError
        ? error
        : new ClientError(error instanceof SyntaxError ? "protocol" : "offline");
    } finally {
      cancel?.();
    }
  }
  async function callRaw(
    path: string,
    method: string,
    value: unknown,
    authenticate: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    const token = authenticate ? DeviceToken.parse(await options.token()) : undefined;
    const response = await options
      .fetch(origin + path, {
        method,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(value === undefined ? {} : { "content-type": "application/json" }),
        },
        body: JSON.stringify(value),
        signal,
      })
      .catch(() => {
        throw new ClientError(
          "offline",
          "Couldn't reach this computer. Check the connection and try again.",
        );
      });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ClientError(
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 429 || response.status >= 500
            ? "offline"
            : "daemon",
        `HTTP ${response.status}`,
      );
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
  return call;
}
