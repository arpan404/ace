import { z } from "zod";
import {
  ProviderKind,
  AcpIdentity,
  type CatalogModel,
  type ModelFilter,
  type ModelInstanceStatus,
  type ModelListOptions,
  type ModelListResult,
  type ModelResolution,
  type ModelRoleSpec,
} from "@ace/protocol";

export const ModelInstance = z
  .object({
    id: z.string().min(1).max(256),
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
/** Must settle after abort, once all owned I/O resources have been released. */
export type DiscoverModels = (
  instance: ModelInstance,
  signal: AbortSignal,
) => Promise<readonly CatalogModel[]>;
export type CacheEntry = {
  provider: ModelInstance["provider"];
  instance: string;
  revision: string;
  refreshedAt: number;
  models: readonly CatalogModel[];
};
export interface CatalogStorage {
  load(): CacheEntry[];
  replace(entry: CacheEntry): void | Promise<void>;
  remove(instance: string): void | Promise<void>;
  close(): void | Promise<void>;
}
export interface ModelCatalogApi {
  list(options?: ModelListOptions): ModelListResult;
  resolve(spec: ModelRoleSpec): ModelResolution;
  invalidate(filter?: ModelFilter): Promise<void>;
  refresh(filter?: ModelFilter): Promise<ModelInstanceStatus[]>;
}
export type Deadline = (expire: () => void, milliseconds: number) => () => void;
