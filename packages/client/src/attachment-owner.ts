import type { ServerMessage } from "@ace/protocol";
import type { OneWayMessage } from "./one-way.ts";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import type { RequestOptions } from "./types.ts";

export interface AttachmentOwner {
  request<Q extends ServiceRequest>(
    input: Q,
    options?: RequestOptions,
  ): Promise<ServiceResponse<Q>>;
  onMessage(listener: (message: ServerMessage) => void): () => void;
  send(message: OneWayMessage): void;
}
