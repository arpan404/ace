import type { ClientApi } from "./api.ts";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import { ClientError, type RequestOptions } from "./types.ts";

export type FileClient = Pick<ClientApi, "request" | "send">;
/** A transfer belongs to one uninterrupted ready lifetime, even if numeric channels are reused. */
export function fileConnection(client: ClientApi): { client: FileClient; close(): void } {
  if (client.state !== "ready") throw new ClientError("offline");
  let invalid = false;
  const stop = client.connectionState().subscribe(() => {
    if (client.state !== "ready") invalid = true;
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
