import { pluralCount, type ReadinessTone } from "@ace/ui-core";
import type { ProviderEntry } from "./provider-entries.ts";

/**
 * An installed provider's line on the Providers list: its state in words ("Ready", or what's
 * wrong in its status colour) and how many accounts ace has on it.
 */
export function listState(entry: ProviderEntry): {
  text: string;
  tone: ReadinessTone;
  accounts: string | undefined;
} {
  const { view, install } = entry;
  const accounts = entry.accountCount ? pluralCount(entry.accountCount, "account") : undefined;
  if (!view)
    return {
      text: install.kind !== "acp" ? "Checking…" : install.added ? "Added by command" : "Ready",
      tone: install.kind !== "acp" ? "idle" : "ready",
      accounts,
    };
  if (view.ready) return { text: "Ready", tone: "ready", accounts };
  return {
    text: view.primary === "sign_in" ? "Signed out" : view.summary,
    tone: view.tone,
    accounts,
  };
}

/** The newer version an update would bring, when the CLI or the registry says. */
export function latestVersion(entry: ProviderEntry): string | undefined {
  return entry.row?.latestVersion ?? entry.install.registry?.agent?.version;
}
