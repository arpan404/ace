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

import { accessHttp, type AccessHttp, type AccessOptions } from "./access-http.ts";

export type { AccessOptions } from "./access-http.ts";

export { accessTicket } from "./access-ticket.ts";

/** HTTP access operations never enter the command outbox or place credentials in URLs. */
export class AccessClient {
  private http: AccessHttp;
  constructor(options: AccessOptions) {
    this.http = accessHttp(options);
  }
  async remoteStatus(signal?: AbortSignal) {
    return z
      .object({ remoteAccess: RemoteAccessStatus })
      .parse(await this.http("/v1/status", "GET", undefined, true, signal)).remoteAccess;
  }
  async devices(signal?: AbortSignal) {
    return z
      .array(Device)
      .max(1000)
      .parse(await this.http("/v1/devices", "GET", undefined, true, signal));
  }
  async pairing(scopes: z.input<typeof PairingRequest>["scopes"], signal?: AbortSignal) {
    return PairingResponse.parse(
      await this.http("/v1/pairings", "POST", PairingRequest.parse({ scopes }), true, signal),
    );
  }
  async revoke(id: string, signal?: AbortSignal) {
    Device.shape.id.parse(id);
    return z
      .object({ revoked: z.literal(true) })
      .parse(
        await this.http(`/v1/devices/${encodeURIComponent(id)}`, "DELETE", undefined, true, signal),
      );
  }
  async ticket(signal?: AbortSignal) {
    return SocketTicket.parse(await this.http("/v1/tickets", "POST", undefined, true, signal));
  }
  async redeem(code: string, name: string, signal?: AbortSignal) {
    return DeviceCredential.parse(
      await this.http("/v1/pair", "POST", PairingRedemption.parse({ code, name }), false, signal),
    );
  }
  async previewLink(port: number, signal?: AbortSignal) {
    z.number().int().min(1).max(65535).parse(port);
    return z
      .object({ url: z.url() })
      .parse(await this.http(`/v1/previews/${port}/link`, "POST", undefined, true, signal));
  }
}
