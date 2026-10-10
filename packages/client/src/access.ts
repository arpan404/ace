import { z } from "zod";
import {
  Device,
  RemoteAccessStatus,
  DeviceCredential,
  PairingRedemption,
  PairingRequest,
  PairingResponse,
} from "@ace/protocol";
import { accessCall, accessOrigin, socketTicket, type AccessOptions } from "./access-call.ts";

export type { AccessOptions } from "./access-call.ts";

/** HTTP access operations never enter the command outbox or place credentials in URLs. */
export class AccessClient {
  private options: AccessOptions;
  constructor(options: AccessOptions) {
    accessOrigin(options.origin);
    this.options = options;
  }
  private call(
    path: string,
    method: string,
    value?: unknown,
    authenticate = true,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return accessCall(this.options, path, method, value, authenticate, signal);
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
  ticket(signal?: AbortSignal) {
    return socketTicket(this.options, signal);
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
