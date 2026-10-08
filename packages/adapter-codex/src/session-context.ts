import type { SessionContext } from "@ace/engine-api";
import type { InteractionId, PermissionMode } from "@ace/protocol";

/** Optional host hooks for policies that Codex can apply without retiring its session. */
export interface CodexSessionContext extends SessionContext {
  getPermissionMode?(): Promise<PermissionMode | null>;
  interactionId?(key: string): InteractionId | undefined;
}
