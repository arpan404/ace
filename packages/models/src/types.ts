import { z } from "zod";
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
    executable: z.string().max(4096).default(""),
    backend: z.enum(["acp", "cursor-sdk"]).optional(),
    homeDir: z.string().min(1).max(4096).optional(),
    cwd: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64).default([]),
    env: z
      .record(z.string().max(256), z.string().max(8192))
      .default({})
      .refine((env) => Object.keys(env).length <= 256),
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
  sourceFailures?: readonly { source: string; reason: string }[];
  sources?: readonly ModelSource[];
};
/** Must settle after abort, once all owned I/O resources have been released. */
export type DiscoverModels = (
  instance: ModelInstance,
  signal: AbortSignal,
  diagnostic?: (metadata: DiscoveryDiagnostics) => void,
) => Promise<readonly CatalogModel[] & { sources?: readonly ModelSourceStatus[] }>;
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
  list(options?: ModelListOptions): ModelListResult;
  resolve(spec: ModelRoleSpec): ModelResolution;
  /** Resolve retained choices without scheduling discovery. Optional for embedded catalogs. */
  resolveCached?(spec: ModelRoleSpec): ModelResolution;
  /** Account revocation removes retained choices and drains obsolete writes before deletion. */
  invalidate(filter?: ModelFilter): Promise<void>;
  refresh(filter?: ModelFilter): Promise<ModelInstanceStatus[]>;
}
export type Deadline = (expire: () => void, milliseconds: number) => () => void;
