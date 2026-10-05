import { z } from "zod";
import {
  AcpIdentity,
  ModelListResult,
  ModelResolution,
  ProviderKind,
  type CommandPayload,
  type ModelsResult,
} from "@ace/protocol";
import type { ServiceRequest } from "./service-requests.ts";
import type { RequestOptions } from "./types.ts";
import { ClientError } from "./types.ts";

/** Select an account before reading its choices. Native CLI scopes use their catalog instance ID. */
const ModelScope = z.discriminatedUnion("provider", [
  z.object({ provider: ProviderKind.exclude(["acp"]), instance: z.string().min(1).max(128) }),
  AcpIdentity.extend({ provider: z.literal("acp") }),
]);
export type ModelScope = z.infer<typeof ModelScope>;
type ModelQuery = Extract<
  ServiceRequest,
  { type: "models.list" | "models.refresh" | "models.resolve" }
>;
export interface ModelServicePort {
  request(query: ModelQuery, options?: RequestOptions): Promise<z.infer<typeof ModelsResult>>;
}
export type CommandSelection = Pick<
  Extract<CommandPayload, { type: "thread.create" }>,
  "provider" | "accountId" | "acpAgentId" | "installationId" | "instanceId" | "model"
>;

/** Account-scoped reads retain each row's default, capabilities and qualified catalog ID. */
export class ModelClient {
  private client: ModelServicePort;
  constructor(client: ModelServicePort) {
    this.client = client;
  }
  async list(
    scope: ModelScope,
    page: { offset?: number; limit?: number } = {},
    options?: RequestOptions,
  ) {
    const filter = ModelScope.parse(scope);
    const reply = await this.client.request(
      { type: "models.list", options: { ...filter, ...page } },
      options,
    );
    return ModelListResult.parse(reply.result);
  }
  async refresh(scope: ModelScope, options?: RequestOptions) {
    const reply = await this.client.request(
      { type: "models.refresh", filter: ModelScope.parse(scope) },
      options,
    );
    return ModelListResult.parse(reply.result);
  }
  async resolve(scope: ModelScope, model?: string, options?: RequestOptions) {
    const reply = await this.client.request(
      {
        type: "models.resolve",
        roleSpec: {
          ...ModelScope.parse(scope),
          role: "new thread",
          ...(model ? { model } : {}),
        },
      },
      options,
    );
    return ModelResolution.parse(reply.result);
  }
  /** Command payload uses the canonical catalog ID, including OpenCode's connection prefix.
   * Re-resolve when the chosen account changes; do not reuse another account's model. */
  async commandSelection(
    scope: ModelScope,
    model?: string,
    options?: RequestOptions,
  ): Promise<CommandSelection> {
    const selected = ModelScope.parse(scope);
    const resolution = await this.resolve(selected, model, options);
    if (!resolution.ok) throw new ClientError("daemon", resolution.reason);
    return scopedSelection(selected, resolution.model.id);
  }
}

/**
 * The command fields for a catalog id already listed under `scope` (`list`): provider, account
 * or ACP identity and that id. Durable commands built offline use it; the daemon resolves the
 * id again at admission and refuses one the account no longer offers.
 */
export function scopedSelection(scope: ModelScope, model: string): CommandSelection {
  const selected = ModelScope.parse(scope);
  return selected.provider === "acp"
    ? { ...selected, model }
    : { provider: selected.provider, accountId: selected.instance, model };
}
