import {
  PermissionMode,
  type PermissionCapabilities,
  type PermissionState,
  type SettingsScope,
  type SettingsLayer,
  ThreadId,
  type PermissionReview,
  type ProviderKind,
} from "@ace/protocol";
import type { ClientApi, ThreadSource } from "./api.ts";
import type { RequestOptions } from "./types.ts";

/** Commands retain the client's durable receipt and reconnect semantics. */
export class PermissionClient {
  private client: ClientApi;
  constructor(client: ClientApi) {
    this.client = client;
  }
  getCapabilities(
    provider: ProviderKind,
    backend?: "acp" | "cursor-sdk",
    options?: RequestOptions,
    instanceId?: string,
  ) {
    return this.client.request(
      {
        type: "permissions.capabilities",
        provider,
        ...(backend ? { backend } : {}),
        ...(instanceId ? { instanceId } : {}),
      },
      options,
    );
  }
  setThread(threadId: string, mode: PermissionMode | null, options?: RequestOptions) {
    return this.client.command(
      { type: "thread.permission.set", threadId: ThreadId.parse(threadId), permissionMode: mode },
      options,
    );
  }
  getDefault(scope: SettingsScope = {}, options?: RequestOptions) {
    return this.client.request(
      { type: "settings.get", key: "permissions.defaultMode", scope },
      options,
    );
  }
  setDefault(mode: PermissionMode, layer: SettingsLayer, options?: RequestOptions) {
    return this.client.request(
      { type: "settings.set", key: "permissions.defaultMode", value: mode, layer },
      options,
    );
  }
}
export function threadPermission(
  source: Pick<ThreadSource, "thread">,
): PermissionState | undefined {
  return source.thread?.permission;
}
/** Native selector ids, with a compatibility fallback for older daemons. */
export function permissionModes(
  capabilities: PermissionCapabilities | undefined,
): readonly PermissionMode[] {
  return capabilities?.permissionModes?.map((mode) => mode.id) ?? capabilities?.modes ?? [];
}
/** Select with interaction:<id>. Review notices are also available through source.item(id). */
export function permissionReview(
  source: Pick<ThreadSource, "interaction">,
  id: string,
): PermissionReview | undefined {
  return source.interaction(id)?.review;
}
