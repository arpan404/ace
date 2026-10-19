import type { ProviderKind, ProviderStatus as DiscoveryStatus } from "@ace/protocol";
import type { AccountSummary } from "@ace/protocol/accounts";
import type { z } from "zod";
import { accountView, type AccountView } from "./accounts.ts";
import type { ModelCatalog } from "./model-catalog-read.ts";
import {
  effortLabel,
  newThreadOptions,
  resolveEffort,
  selectNewThreadModel,
  type AccountOption,
  type ModelOption,
} from "./models.ts";
import { providerAccountModel } from "./provider-account-model.ts";
import { catalogSignal } from "./provider-readiness.ts";
import { providerAccountState } from "./provider-status.ts";
import { providerDisplayName } from "./providers.ts";
import type { StatusDisplay, StatusToken } from "./mobile-status.ts";

/*
 * The native New thread sheet (issue #560): which coding agents a thread can start on, by the
 * same readiness, account and catalog rules the web's New thread uses, and which projects come
 * first. Native code draws these rows; it never decides whether a CLI is usable.
 */

export interface NewThreadModelRow {
  /** The model's identity (`modelKey`); the bridge resolves it again before sending. */
  key: string;
  label: string;
  /** The account (catalog instance) serving it. */
  account: string;
  efforts: { id: string; label: string }[];
  defaultEffort: string | undefined;
}

export interface NewThreadProviderRow {
  provider: ProviderKind;
  name: string;
  /** A thread can start on it now. */
  ready: boolean;
  status: StatusDisplay;
  /** Why it can't be picked, in words; absent when it can. */
  reason: string | undefined;
  accounts: { id: string; label: string; usage: string }[];
  models: NewThreadModelRow[];
}

/** The rows the sheet shows, with the options the bridge resolves a choice against. */
export interface NewThreadAgents {
  providers: NewThreadProviderRow[];
  models: readonly ModelOption[];
  accounts: readonly AccountOption[];
}

const reasons: Partial<Record<string, string>> = {
  not_installed: "Not installed on this computer",
  signed_out: "Signed out. Sign in on your computer.",
  needs_update: "Needs an update on your computer",
  limited: "Usage limit reached",
  attention: "Needs attention on your computer",
  unknown: "Checking sign-in…",
};

const tokens: Partial<Record<string, StatusToken>> = {
  ready: "done",
  signed_out: "needsYou",
  limited: "waiting",
  needs_update: "failed",
  attention: "failed",
};

/**
 * Every coding agent the machine reports (`providers.request` readiness), in its order, joined
 * with its accounts (`accounts.list`) and the model catalog (`models.list`) the way the web's
 * provider statuses join them. One that isn't installed, is signed out, needs an update or lists
 * no models is still listed, unready, with the reason. Turned-off CLIs are left out.
 */
export function newThreadAgents(input: {
  statuses: readonly DiscoveryStatus[];
  accounts: readonly z.infer<typeof AccountSummary>[];
  catalog: ModelCatalog;
  now: number;
}): NewThreadAgents {
  const views = input.accounts.map(accountView);
  const joined = input.statuses
    .filter((row) => row.enabled !== false)
    .map((row) => {
      const model = providerAccountModel({
        provider: row.provider,
        accounts: views,
        row,
        catalog: catalogSignal(input.catalog.models, input.catalog.instances, row.provider),
        now: input.now,
      });
      return { row, model, state: providerAccountState(model) };
    });
  const reconciled: AccountView[] = joined.flatMap((entry) => entry.model.accounts);
  const options = newThreadOptions(
    input.catalog.models,
    reconciled,
    joined.map((entry) => ({ provider: entry.row.provider, state: entry.state })),
  );
  const providers = joined.map(({ row, model, state }): NewThreadProviderRow => {
    const own = options.models.filter((option) => option.provider === row.provider);
    const ready = state === "ready" && own.length > 0;
    const label = model.view?.label ?? "Unknown";
    return {
      provider: row.provider,
      name: providerDisplayName(row.provider),
      ready,
      status: {
        label: ready ? "Ready" : label,
        token: ready ? "done" : (tokens[state] ?? "neutral"),
      },
      reason: ready
        ? undefined
        : state === "ready"
          ? "No models listed on this computer"
          : (reasons[state] ?? label),
      accounts: options.accounts
        .filter((account) => account.provider === row.provider)
        .map((account) => ({ id: account.id, label: account.label, usage: account.usage })),
      models: own.map((option) => ({
        key: option.key,
        label: option.label,
        account: option.account,
        efforts: option.efforts.map((id) => ({ id, label: effortLabel(id) })),
        defaultEffort: option.defaultEffort,
      })),
    };
  });
  return { providers, models: options.models, accounts: options.accounts };
}

/** What the person picked; any part may be missing or no longer offered. */
export interface NewThreadChoice {
  provider?: string | undefined;
  model?: string | undefined;
  account?: string | undefined;
  effort?: string | undefined;
}

export type NewThreadStart =
  | { ok: true; provider: ProviderKind; model: ModelOption; effort: string | undefined }
  | { ok: false; reason: string };

/**
 * The choice as it can start: the picked agent when it is ready (else the first ready one when
 * none was picked), then the account and model `selectNewThreadModel` gives, then the model's
 * effort. A picked agent that isn't ready is refused with its reason, never swapped silently.
 */
export function selectNewThreadAgent(
  agents: NewThreadAgents,
  choice: NewThreadChoice,
): NewThreadStart {
  const picked = agents.providers.find((row) => row.provider === choice.provider);
  if (choice.provider !== undefined && !picked)
    return { ok: false, reason: "That coding agent isn't on this computer." };
  if (picked && !picked.ready)
    return { ok: false, reason: `${picked.name}: ${picked.reason ?? "Not ready"}` };
  const row = picked ?? agents.providers.find((entry) => entry.ready);
  if (!row) return { ok: false, reason: "No coding agent is ready on this computer." };
  const { model } = selectNewThreadModel({
    models: agents.models,
    accounts: agents.accounts,
    provider: row.provider,
    model: choice.model,
    account: choice.account,
  });
  if (!model) return { ok: false, reason: `${row.name}: No models listed on this computer` };
  const effort = resolveEffort(model.efforts, choice.effort, model.defaultEffort);
  return { ok: true, provider: row.provider, model, effort };
}

export interface NewThreadProject {
  id: string;
  name: string;
  path: string;
  /** Has a thread on this machine; recent projects come first. */
  recent: boolean;
}

/**
 * Projects for the picker: those with the most recent thread activity first, then the rest by
 * name. `activity` is each thread's project and when it last moved.
 */
export function newThreadProjects(
  projects: readonly { id: string; name: string; path: string }[],
  activity: Iterable<{ workspaceId: string; at: number }>,
): NewThreadProject[] {
  const latest = new Map<string, number>();
  for (const entry of activity)
    latest.set(entry.workspaceId, Math.max(latest.get(entry.workspaceId) ?? 0, entry.at));
  return projects
    .map((project) => ({
      id: project.id,
      name: project.name || project.id,
      path: project.path,
      recent: latest.has(project.id),
      at: latest.get(project.id) ?? -1,
    }))
    .toSorted((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    .map(({ at: _at, ...row }) => row);
}
