import { z } from "zod";
import {
  Device,
  RemoteAccessStatus,
  DeviceCredential,
  PairingRedemption,
  PairingRequest,
  PairingResponse,
  SocketTicket,
} from "@ace/protocol";
import { ClientError } from "./types.ts";

const noop = () => {};

export interface AccessOptions {
  origin: string;
  /** Transport owns trusted TLS/pinning. Browsers require a trusted HTTPS certificate. */
  fetch(input: string, init: RequestInit): Promise<Response>;
  token(): Promise<string>;
  timeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}
/** HTTP access operations never enter the command outbox or place credentials in URLs. */
export class AccessClient {
  private options: AccessOptions;
  private origin: string;
  constructor(options: AccessOptions) {
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
    this.origin = url.origin;
    this.options = options;
  }
  private async call(
    path: string,
    method: string,
    value?: unknown,
    authenticate = true,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const schedule =
      this.options.schedule ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      });
    let cancel = noop;
    const timedOut = new Promise<never>((_, reject) => {
      cancel = schedule(() => {
        controller.abort();
        reject(
          new ClientError(
            "offline",
            "This computer didn't respond. Check the connection and try again.",
          ),
        );
      }, this.options.timeoutMs ?? 15000);
    });
    try {
      return await Promise.race([
        this.callRaw(
          path,
          method,
          value,
          authenticate,
          AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
        ),
        timedOut,
      ]);
    } catch (error) {
      throw error instanceof ClientError
        ? error
        : new ClientError(error instanceof SyntaxError ? "protocol" : "offline");
    } finally {
      cancel();
    }
  }
  private async callRaw(
    path: string,
    method: string,
    value?: unknown,
    authenticate = true,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = authenticate
      ? DeviceCredential.shape.token.parse(await this.options.token())
      : undefined;
    const response = await this.options
      .fetch(this.origin + path, {
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
  async remoteStatus(signal?: AbortSignal) {
    return z
      .object({ remoteAccess: RemoteAccessStatus })
      .parse(await this.call("/v1/status", "GET", undefined, true, signal)).remoteAccess;
  }
  async devices(signal?: AbortSignal) {
    return z
      .array(Device)
      .max(1000)
      .parse(await this.call("/v1/devices", "GET", undefined, true, signal));
  }
  async pairing(scopes: z.input<typeof PairingRequest>["scopes"], signal?: AbortSignal) {
    return PairingResponse.parse(
      await this.call("/v1/pairings", "POST", PairingRequest.parse({ scopes }), true, signal),
    );
  }
  async revoke(id: string, signal?: AbortSignal) {
    Device.shape.id.parse(id);
    return z
      .object({ revoked: z.literal(true) })
      .parse(
        await this.call(`/v1/devices/${encodeURIComponent(id)}`, "DELETE", undefined, true, signal),
      );
  }
  async ticket(signal?: AbortSignal) {
    return SocketTicket.parse(await this.call("/v1/tickets", "POST", undefined, true, signal));
  }
  async redeem(code: string, name: string, signal?: AbortSignal) {
    return DeviceCredential.parse(
      await this.call("/v1/pair", "POST", PairingRedemption.parse({ code, name }), false, signal),
    );
  }
  async previewLink(port: number, signal?: AbortSignal) {
    z.number().int().min(1).max(65535).parse(port);
    return z
      .object({ url: z.url() })
      .parse(await this.call(`/v1/previews/${port}/link`, "POST", undefined, true, signal));
  }
}
