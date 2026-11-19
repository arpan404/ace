import type { ClientApi } from "./api.ts";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import { ClientError, type RequestOptions } from "./types.ts";

export type FileClient = Pick<ClientApi, "request" | "send">;
/** What a transfer needs of a client: `ClientApi`, or `ClientCore` in a native app's bridge. */
export type FileHost = Pick<ClientApi, "state" | "connectionGeneration" | "request" | "send">;
/**
 * A transfer belongs to one daemon socket: one uninterrupted ready lifetime, not moved to another
 * path (ADR 0114), since numeric channels are the socket's and may be reused on the next.
 */
export function fileConnection(client: FileHost): { client: FileClient; close(): void } {
  if (client.state !== "ready") throw new ClientError("offline");
  let invalid = false;
  const socket = client.connectionGeneration();
  const started = socket.getSnapshot();
  const stop = socket.subscribe(() => {
    if (socket.getSnapshot() !== started) invalid = true;
  });
  const assert = () => {
    if (invalid || client.state !== "ready") throw new ClientError("offline");
  };
  return {
    client: {
      async request<Q extends ServiceRequest>(
        input: Q,
        options?: RequestOptions,
      ): Promise<ServiceResponse<Q>> {
        assert();
        const result = await client.request(input, options);
        assert();
        return result;
      },
      send(message) {
        assert();
        client.send(message);
      },
    },
    close: stop,
  };
}
