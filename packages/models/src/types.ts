import { z } from "zod";
import {
  ENV_NAME_LIMIT,
  ENV_VALUE_LIMIT,
  environmentLaunchError,
} from "@ace/provider-kit/process-env";
import {
  ProviderKind,
  AcpIdentity,
  type CatalogModel,
  type ModelFilter,
  type ModelSourceStatus,
  type ModelInstanceStatus,
  type ModelListOptions,
  type ModelListResult,
  type ModelResolution,
  type ModelSource,
  type ModelRoleSpec,
  type NativePermissionMode,
} from "@ace/protocol";

export const ModelInstance = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(256).optional(),
    provider: ProviderKind,
    ...AcpIdentity.partial().shape,
    profileRevision: z.string().max(256).optional(),
    installationVersion: z.string().max(256).optional(),
    loginRevision: z.string().min(1).max(256),
    /**
     * ACP agents only: when the catalog may open a metadata-only probe session (initialize and
     * session/new, never a prompt). `automatic`: a reviewed profile, probed the first time a
     * read asks for this row. `on-request`: an unprofiled agent, probed only when the person asks
     * for this row's models. Absent: sessions alone report the row.
     */
    modelProbe: z.enum(["automatic", "on-request"]).optional(),
    /** The ACP method the person signed in with, selected again when the agent asks for one. */
    signInMethod: z.string().min(1).max(128).optional(),
    executable: z.string().max(4096).default(""),
    backend: z.enum(["acp", "cursor-sdk"]).optional(),
    homeDir: z.string().min(1).max(4096).optional(),
    cwd: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64).default([]),
    env: z
      .record(z.string().max(ENV_NAME_LIMIT), z.string().max(ENV_VALUE_LIMIT))
      .default({})
      // Only an environment a process can start with: anything larger fails at launch anyway.
      .refine((env) => environmentLaunchError(env) === undefined),
    /** Variables the discovery process must not inherit from the daemon's own environment. */
    unsetEnv: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .refine(
    (instance) =>
      instance.backend === "cursor-sdk"
        ? instance.provider === "cursor" && !!instance.homeDir
        : !!instance.executable,
    "SDK instances need a private home; CLI instances need an executable",
  );
export type ModelInstance = z.infer<typeof ModelInstance>;
export type InstanceInput = z.input<typeof ModelInstance>;
export type DiscoveryReport = {
  models: readonly CatalogModel[];
  sources: readonly ModelSourceStatus[];
};
/** Non-secret metadata learned before discovery completes, including failed attempts. */
export type DiscoveryDiagnostics = {
  cliVersion?: string;
  stage?: "version" | "connections" | "metadata" | "model-ids";
  /** Bounded fixed reasons for skipped SDK rows. Local logger only, never cache/wire. */
  rejectedModels?: readonly { index: number; reason: string }[];
  /** Attempt-local sanitized text. Never part of a catalog row or cache entry. */
  sourceFailures?: readonly {
    source: string;
    reason: string;
    stage?: "metadata" | "model-ids";
  }[];
  sources?: readonly ModelSource[];
};
/** Must settle after abort, once all owned I/O resources have been released. */
export type DiscoverModels = (
  instance: ModelInstance,
  signal: AbortSignal,
  diagnostic?: (metadata: DiscoveryDiagnostics) => void,
) => Promise<
  readonly CatalogModel[] & {
    sources?: readonly ModelSourceStatus[];
    /** Session modes the probe's opened session reported (ACP agents). */
    permissionModes?: readonly NativePermissionMode[];
  }
>;
export type CacheEntry = {
  permissionModes?: readonly NativePermissionMode[] | undefined;
  provider: ModelInstance["provider"];
  instance: string;
  revision: string;
  loginRevision?: string | undefined;
  refreshedAt: number;
  models: readonly CatalogModel[];
  schemaVersion?: number;
  identityRevision?: string | undefined;
  connectionRevision?: string | undefined;
  sources?: readonly ModelSourceStatus[] | undefined;
};
export interface CatalogStorage {
  load(): CacheEntry[];
  replace(entry: CacheEntry): void | Promise<void>;
  remove(instance: string): void | Promise<void>;
  close(): void | Promise<void>;
}
export interface ModelCatalogApi {
  updatePermissionModes?(instance: string, modes: readonly NativePermissionMode[]): void;
  listen?(listener: (filter: ModelFilter) => void): () => void;
  /** Keeps CLI-owned connections re-checked while the returned stop is not called. */
  observeConnections?(): () => void;
  list(options?: ModelListOptions): ModelListResult;
  resolve(spec: ModelRoleSpec): ModelResolution;
  /** Resolve retained choices without scheduling discovery. Optional for embedded catalogs. */
  resolveCached?(spec: ModelRoleSpec): ModelResolution;
  /** Account revocation removes retained choices and drains obsolete writes before deletion. */
  invalidate(filter?: ModelFilter): Promise<void>;
  refresh(filter?: ModelFilter): Promise<ModelInstanceStatus[]>;
  /**
   * Wait for the accounts in `filter` that have never loaded a model list, or loaded an empty one
   * that is due for discovery, as lazy discovery loads them: a discovery already running is
   * shared, and one that failed waits out its retry pause instead of running again. Optional for
   * embedded catalogs.
   */
  loadMissing?(filter?: ModelFilter): Promise<ModelInstanceStatus[]>;
}
export type Deadline = (expire: () => void, milliseconds: number) => () => void;
