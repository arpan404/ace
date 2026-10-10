import { readinessView, type ReadinessTone, type ReadinessView } from "@ace/ui-core";
import { compareVersions } from "@ace/ui-core/acp-registry";
import { useConnectionState } from "@ace/client-react";
import { useQuery } from "@tanstack/react-query";
import { useProviderReadiness, type ProviderReadiness } from "@/lib/provider-readiness.ts";
import { useProviderAccountModels } from "@/features/accounts/index.ts";
import type { ProviderInstall } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";

/**
 * One provider as the Providers pages show it: what discovery found (with ace's accounts on it),
 * its CLI's own readiness, and that readiness in words. ACP agents have no readiness row.
 */
export interface ProviderEntry {
  /** The provider's page: its kind, or `acp:<name>` for an ACP agent. */
  id: string;
  install: ProviderInstall;
  row: ProviderReadiness | undefined;
  accountCount?: number | undefined;
  view: ReadinessView | undefined;
}

export const providerPageId = (install: ProviderInstall): string =>
  install.kind === "acp" ? `acp:${install.name}` : install.kind;

/** Not on this computer: listed apart, with how to get it. */
export function isMissing(entry: ProviderEntry): boolean {
  // An approved custom command has no registry install to offer.
  if (entry.install.added) return false;
  return entry.view
    ? entry.view.state === "not_installed"
    : entry.install.state === "not_installed";
}

/** Every provider, live: discovery, readiness and the model catalog's say on each. */
export function useProviderEntries() {
  const backend = useSettingsBackend();
  const ready = useConnectionState() === "ready";
  const providers = useQuery({ ...settingsQueries.providers(backend), enabled: ready });
  const readiness = useProviderReadiness();
  const { accounts: accountQuery, model } = useProviderAccountModels();
  const entries = providers.data?.map((install): ProviderEntry => {
    const row =
      install.kind === "acp"
        ? undefined
        : readiness.data?.find((entry) => entry.provider === install.kind);
    const accounts = model(install.kind, install.acpAgentId);
    return {
      id: providerPageId(install),
      install,
      row,
      view: accounts.view ?? (row ? readinessView(row) : undefined),
      accountCount: accountQuery.data && accounts.loaded ? accounts.accounts.length : undefined,
    };
  });
  return { entries, query: providers };
}

/**
 * The status line of a provider: its readiness in words, or for an ACP agent (which has none)
 * how ace reaches it; with why it needs attention, when it does.
 */
export function entryStatus(entry: ProviderEntry): {
  tone: ReadinessTone;
  text: string;
  problem?: string | undefined;
} {
  const { install, view } = entry;
  if (view)
    return {
      tone: view.tone,
      text: view.summary,
      problem: view.tone === "problem" ? view.detail : undefined,
    };
  if (install.kind !== "acp")
    return {
      tone: "idle",
      text: install.state === "not_installed" ? "Not installed" : "Checking…",
    };
  if (install.added) return { tone: "idle", text: "Added by command" };
  const listed = install.registry?.agent;
  if (install.registry && listed && compareVersions(listed.version, install.registry.version) > 0)
    return { tone: "action", text: `Update available · ${listed.version}` };
  if (install.state === "not_installed") return { tone: "idle", text: "Not installed" };
  return { tone: "ready", text: "Runs through ACP" };
}
