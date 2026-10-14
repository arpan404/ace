import {
  type AccessMode,
  type AccessModeOffer,
  type Capabilities,
  type PermissionState,
  type SettingsLayer,
  ThreadId,
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
  /** The thread's own access; null follows its project and the daemon default. */
  setThread(threadId: string, access: AccessMode | null, options?: RequestOptions) {
    return this.client.command(
      { type: "thread.permission.set", threadId: ThreadId.parse(threadId), access },
      options,
    );
  }
  /** This daemon's access for new threads. */
  getDefault(options?: RequestOptions) {
    return this.client.request(
      { type: "settings.get", key: "access.defaultMode", scope: {} },
      options,
    );
  }
  setDefault(
    access: AccessMode,
    layer: SettingsLayer = { kind: "global" },
    options?: RequestOptions,
  ) {
    return this.client.request(
      { type: "settings.set", key: "access.defaultMode", value: access, layer },
      options,
    );
  }
}
export function threadPermission(
  source: Pick<ThreadSource, "thread">,
): PermissionState | undefined {
  return source.thread?.permission;
}
/** The ace access modes an instance genuinely supports, least capable first. */
export function accessModes(
  capabilities: Pick<Capabilities, "accessModes"> | undefined,
): readonly AccessModeOffer[] {
  return capabilities?.accessModes ?? [];
}
