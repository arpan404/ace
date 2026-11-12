import type { IdSource } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { EngineClock } from "./actor.ts";
import type { EngineLimits } from "./limits.ts";
import type { PermissionSettings } from "./permissions.ts";
import type { PrepareInput } from "./input.ts";
import type { RecoveryPorts, RecoveryPreferences } from "./recovery.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { Sessions } from "./sessions.ts";
import type { TransitionIO } from "./transitions.ts";
import type { WorktreeGit } from "./worktree-title.ts";

/** What the engine is built with: its ports to providers, the host and the person's settings. */
export interface EngineOptions {
  /**
   * Windows only: startup recovery could not prove every process of the previous run gone, so
   * restart recovery must not report that run's provider work as stopped.
   */
  previousProcessesUnverified?: boolean;
  waitForProvider?(provider: import("@ace/protocol").ProviderKind): Promise<void>;
  onModelUnavailable?(
    provider: import("@ace/protocol").ProviderKind,
    model: string,
    instance?: string,
  ): void;
  onCommandEvent?(event: import("./provider-command-metadata.ts").ProviderCommandEvent): void;
  models?: import("@ace/models").ModelCatalogApi;
  worktreeGit?: WorktreeGit;
  /** The person's message that named a thread, for generating its title once. */
  onNamingPrompt?(threadId: ThreadId, input: readonly import("@ace/protocol").ContentPart[]): void;
  permissionSettings?: PermissionSettings;
  providerEnabled?(provider: import("@ace/protocol").ProviderKind, instance?: string): boolean;
  selectInstance?: (
    provider: string,
    backend?: import("@ace/engine-api").ProviderBackend,
  ) => string | undefined;
  transitions?: TransitionIO;
  prepareInput?: PrepareInput;
  recovery?: RecoveryPorts;
  preferences?: Partial<RecoveryPreferences>;
  limits?: Partial<EngineLimits>;
  beforeSend?(threadId: ThreadId, commandId: import("@ace/protocol").CommandId): Promise<void>;
  /** `runCommands` is false when the thread's access is Read-only: no setup script runs. */
  prepareWorkspace?(threadId: ThreadId, options: { runCommands: boolean }): Promise<string>;
  assertWorkspaceAvailable?(cwd: string, threadId: ThreadId): Promise<void>;
  machine?: { host: string; name: string };
  sessionContext?: NonNullable<ConstructorParameters<typeof Sessions>[0]["context"]>;
  ids?: IdSource;
  threadId?: () => string;
  commandId?: () => string;
  registry?: AdapterRegistry;
  clock?: EngineClock;
  /** Durable batching latency is independent of the status/recovery clock. */
  batchScheduler?: Pick<EngineClock, "setTimer">;
  idleMs?: number;
  silenceMs?: number;
  onError?: (error: unknown) => void;
  /** Stopping part of a settled thread's tree failed: for the log only, never the person. */
  onSettleCleanupFailure?: (thread: ThreadId, error: unknown) => void;
  onSessionOpenFailure?: (
    thread: ThreadId,
    details: import("@ace/protocol").ProviderErrorDetails,
    route?: import("./session-open-route.ts").SessionOpenRoute,
  ) => void;
  onProviderDiagnostic?: (thread: ThreadId, raw: import("@ace/protocol").RawPayload[]) => void;
  aceToolAction?: typeof import("@ace/mcp-server").aceToolAction;
  mcp?: (
    threadId: ThreadId,
    agentId: string,
    lifetime: AbortSignal,
  ) => NonNullable<import("@ace/engine-api").SessionContext["aceMcp"]>;
}
