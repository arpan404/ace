import { z } from "zod";
import { AccessMode } from "./permissions.ts";
import { ProviderKind } from "./provider-data.ts";

const id = z.string().min(1).max(256);
const effort = z.string().min(1).max(64);

/** What an agent reads before delegating: current models by default, every model by query. */
export const AgentModelsInput = z.strictObject({
  provider: ProviderKind.optional(),
  /** A model name as a person writes it ("opus 5.5"); legacy models are searched too. */
  query: z.string().min(1).max(256).optional(),
});
export type AgentModelsInput = z.infer<typeof AgentModelsInput>;

/** One account, stated once per provider. A field at its usual value is left out. */
export const AgentModelsAccount = z.object({
  /** The id `delegate` takes as accountId. */
  id,
  /** The name the person gave the account; left out for the CLI's own login. */
  label: z.string().max(256).optional(),
  /** Left out when logged in. */
  auth: z.enum(["logged_out", "unknown"]).optional(),
  /** Left out when available, or when unknown along with the login state. */
  availability: z.string().max(64).optional(),
  /** Access modes a child may take here; left out when every mode up to the caller's. */
  access: z.array(AccessMode).max(4).optional(),
  /** Set only when the provider's CLI is missing. */
  installed: z.literal(false).optional(),
  /** Set only when the person turned the account off. */
  enabled: z.literal(false).optional(),
  /** This account's default model, when the provider's accounts disagree on one. */
  default: id.optional(),
});
export type AgentModelsAccount = z.infer<typeof AgentModelsAccount>;

/** Models that share their efforts, default effort and serving accounts, in catalog order. */
export const AgentModelsSet = z.object({
  /** Model ids `delegate` takes, in catalog order (nearest first for a query). */
  ids: z.array(id).min(1).max(64),
  /**
   * Effort ids, comma-separated, weakest first; empty when the models take no effort. Left out
   * when they are the roster's shared `efforts`.
   */
  efforts: z.string().max(2048).optional(),
  defaultEffort: effort.optional(),
  /** Accounts serving these models, by label when unique, else id; left out when all do. */
  accounts: z.array(id).max(64).optional(),
  /** Superseded by a newer release; listed because the person pinned it or a query found it. */
  legacy: z.literal(true).optional(),
  /** Display names the ids do not already spell. */
  names: z.record(id, z.string().max(256)).optional(),
});
export type AgentModelsSet = z.infer<typeof AgentModelsSet>;

export const AgentModelsProvider = z.object({
  provider: ProviderKind,
  accounts: z.array(AgentModelsAccount).max(64),
  /** The default model, when every account agrees on it. */
  default: id.optional(),
  sets: z.array(AgentModelsSet).max(64),
  /** Runnable models left out of the default list; a query finds them. */
  omitted: z.number().int().positive().optional(),
});
export type AgentModelsProvider = z.infer<typeof AgentModelsProvider>;

export const AgentModelRoster = z.object({
  providers: z.array(AgentModelsProvider).max(16),
  /** The efforts most sets share, comma-separated, weakest first. */
  efforts: z.string().min(1).max(2048).optional(),
  /** Providers with accounts but no model a child can run, such as an empty catalog. */
  noModels: z.array(ProviderKind).max(16).optional(),
  caller: z.object({
    provider: ProviderKind,
    model: id.optional(),
    access: AccessMode.nullable(),
  }),
});
export type AgentModelRoster = z.infer<typeof AgentModelRoster>;
