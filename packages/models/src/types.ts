import { z } from "zod";
import {
  ProviderKind,
  type CatalogModel,
  type ModelFilter,
  type ModelInstanceStatus,
  type ModelListOptions,
  type ModelListResult,
  type ModelResolution,
  type ModelRoleSpec,
} from "@ace/protocol";

export const ModelInstance = z.object({
  id: z.string().min(1).max(256),
  provider: ProviderKind,
  loginRevision: z.string().min(1).max(256),
  executable: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64).default([]),
  env: z
    .record(z.string().max(256), z.string().max(8192))
    .default({})
    .refine((env) => Object.keys(env).length <= 256),
});
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
  refresh(filter?: ModelFilter): Promise<ModelInstanceStatus[]>;
}
export type Deadline = (expire: () => void, milliseconds: number) => () => void;
