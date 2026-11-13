import type { SourceControlReadiness } from "@ace/protocol";
import type { ForgeKind } from "@ace/protocol/forge";
import { forgeCanCheck, forgeClis } from "@ace/ui-core";
import { Fragment, type ReactNode } from "react";
import { SettingNote } from "@/components/setting-row.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { apiState } from "@/lib/source-control-cache.ts";

/**
 * What the page last read for the shown host, folded into that host's row in Git hosts: its
 * sign-in, its CLI and the CLI's other accounts, and what to do when it isn't ready.
 */
export interface ShownHostStatus {
  status: SourceControlReadiness | undefined;
  forge: ForgeKind;
  loading: boolean;
  /** Whether ace can read this provider's status, so Rescan has something to read. */
  canRescan: boolean;
  /** Why the status or the last save failed, already in words. */
  error: string | undefined;
}

/** The shown host's facts as words: sign-in, CLI, then the CLI's other accounts. */
export function hostFacts(status: SourceControlReadiness, forge: ForgeKind): string[] {
  if (!forgeCanCheck(forge)) return ["API support pending"];
  const facts = [
    apiState(status),
    status.cli === "available"
      ? `${forgeClis[forge] ?? ""} ${status.version}`.trim()
      : "CLI not installed",
  ];
  const others = status.accounts.filter((entry) => entry.login !== status.account);
  if (others.length)
    facts.push(
      `Other CLI accounts: ${others
        .map((entry) => `${entry.login}${entry.active ? " (active)" : ""}`)
        .join(", ")}`,
    );
  // apiState already says "CLI not installed" when nothing else is wrong.
  return [...new Set(facts)];
}

/** The shown host's row description: its hostname, then each fact on the same line. */
export function shownHostDescription(host: string, shown: ShownHostStatus): ReactNode {
  if (shown.loading) return <Skeleton className="mt-1 w-40" />;
  if (!shown.status) return host;
  const parts = [host, ...hostFacts(shown.status, shown.forge)];
  return parts.map((part, index) => (
    <Fragment key={part}>
      {index > 0 && " · "}
      <span>{part}</span>
    </Fragment>
  ));
}

/** Notes under Git hosts: the next step while the shown host isn't ready, and failures. */
export function ShownHostNotes({ shown }: { shown: ShownHostStatus }) {
  const { status, forge, loading, error } = shown;
  return (
    <>
      {(forge === "gitlab" || forge === "origin") && (
        <SettingNote>
          Pull request details and changed files are available in Code review. Reviews and merge
          actions open on the host.
        </SettingNote>
      )}
      {/* When everything is ready the row already says so. */}
      {status && !loading && status.api !== "ready" && (
        <SettingNote role="status">{status.instructions}</SettingNote>
      )}
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </>
  );
}
