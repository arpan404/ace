import { BrowserOrigin, BrowserOriginGrant, ThreadId } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { ClientError, type RequestOptions } from "./types.ts";

/** Browser grants are one-shot requests; never persisted or replayed as intents. */
export class BrowserOriginsClient {
  private client: Pick<ClientApi, "request">;
  constructor(client: Pick<ClientApi, "request">) {
    this.client = client;
  }
  list(threadId: string, options?: RequestOptions): Promise<BrowserOriginGrant[]> {
    return this.read({ type: "browser.origins.list", threadId: ThreadId.parse(threadId) }, options);
  }
  grant(threadId: string, origin: string, options?: RequestOptions): Promise<BrowserOriginGrant[]> {
    return this.read(
      {
        type: "browser.origins.grant",
        threadId: ThreadId.parse(threadId),
        origin: BrowserOrigin.parse(origin),
      },
      options,
    );
  }
  revoke(
    threadId: string,
    origin: string,
    options?: RequestOptions,
  ): Promise<BrowserOriginGrant[]> {
    return this.read(
      {
        type: "browser.origins.revoke",
        threadId: ThreadId.parse(threadId),
        origin: BrowserOrigin.parse(origin),
      },
      options,
    );
  }
  private async read(
    input: Extract<
      import("./service-requests.ts").ServiceRequest,
      { type: "browser.origins.list" | "browser.origins.grant" | "browser.origins.revoke" }
    >,
    options?: RequestOptions,
  ): Promise<BrowserOriginGrant[]> {
    const response = await this.client.request(input, options);
    if (!response.ok) throw new ClientError("daemon", response.error);
    const grants = BrowserOriginGrant.array().max(256).safeParse(response.result);
    if (!grants.success) throw new ClientError("protocol", "Invalid browser origin grant list");
    return grants.data;
  }
}
