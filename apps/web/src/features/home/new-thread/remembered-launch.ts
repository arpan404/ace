import { z } from "zod";
import { AcpIdentity, ProviderKind } from "@ace/protocol";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { Choices } from "./choices.ts";

/** The account a start ran on, as `thread.create` selects it. */
const LaunchScope = z.union([
  z.object({ provider: ProviderKind.exclude(["acp"]), instance: z.string().min(1).max(128) }),
  AcpIdentity.extend({ provider: z.literal("acp") }),
]);

/**
 * What the last thread started from New thread ran on, ready to send again: the account, the
 * catalog id and its launch options, with the choices they were resolved from. A text-only
 * message sends on it while the model catalog is still loading.
 */
export const RememberedLaunch = z.object({
  scope: LaunchScope,
  /** The catalog id `thread.create` carries. */
  model: z.string().min(1).max(256),
  /** The model's name for the chip until the catalog arrives. */
  label: z.string().max(256),
  /** The choices it was resolved from: the model's option key, account, effort and speed. */
  key: z.string().min(1),
  account: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  speed: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
});
export type RememberedLaunch = z.infer<typeof RememberedLaunch>;

const storageKey = "ace.home.newThread.launch";
export const loadLaunch = (storage: KeyValueStorage | undefined): RememberedLaunch | undefined =>
  readJson<RememberedLaunch | undefined>(storage, storageKey, RememberedLaunch, undefined);
export const saveLaunch = (storage: KeyValueStorage | undefined, launch: RememberedLaunch) =>
  writeJson(storage, storageKey, launch);

/** An unset wish agrees with anything; a set one only with the same value. */
const agrees = (wanted: string | undefined, had: string | undefined) =>
  wanted === undefined || wanted === had;

/**
 * The remembered launch, when nothing on this page asks for something else: the provider asked
 * for (picked, the project's, or the starting one once known), the project's default model, the
 * provider a saved preparation pinned, and this draft's model, account, effort and speed. Only
 * used before the catalog loads; once it has, the catalog decides.
 */
export function launchBeforeCatalog(
  launch: RememberedLaunch | undefined,
  wanted: {
    choices: Choices;
    provider: ProviderKind | undefined;
    projectModel: string | undefined;
    restoredProvider: ProviderKind | undefined;
  },
): RememberedLaunch | undefined {
  if (!launch) return undefined;
  const { choices } = wanted;
  return agrees(wanted.provider, launch.scope.provider) &&
    agrees(wanted.restoredProvider, launch.scope.provider) &&
    agrees(wanted.projectModel, launch.model) &&
    agrees(choices.model, launch.key) &&
    agrees(choices.account, launch.account) &&
    agrees(choices.effort, launch.effort) &&
    agrees(choices.speed, launch.speed)
    ? launch
    : undefined;
}
