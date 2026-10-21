import { CaretRightIcon } from "@phosphor-icons/react";
import { useAccountViews } from "@/lib/account-views.ts";
import { AccountBadge } from "@/components/ui/provider-account-icon.tsx";
import { Link } from "@tanstack/react-router";
import { ProviderSetupRow } from "@/features/provider-setup/index.ts";
import { SettingNote, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { AddAcpAgentRow } from "./add-acp-agent.tsx";
import {
  isMissing,
  updateAvailable,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";

/**
 * Settings → Providers: every coding agent on this computer as one calm row in columns (its
 * mark and name, its state, at most the one action it needs, its accounts), each opening its
 * own page. Agents that aren't installed sit in a group below, with the way to add an ACP agent.
 */
export function ProviderSettings() {
  const { entries, query } = useProviderEntries();
  if (query.isPending)
    return <ListSkeleton label="providers" shape="row" rows={5} className="mt-10" />;
  if (!entries)
    return (
      <p role="alert" className="mt-10 text-sm text-muted-foreground">
        Couldn't check providers.{" "}
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </p>
    );
  const installed = entries.filter((entry) => !isMissing(entry));
  const missing = entries.filter(isMissing);
  return (
    <>
      <SettingSection label="Installed providers">
        {installed.length ? (
          installed.map((entry) => <ProviderRow key={entry.id} entry={entry} />)
        ) : (
          <SettingNote>
            No coding agents found yet. Install one below, then check again.
          </SettingNote>
        )}
      </SettingSection>
      <SettingSection label="Available to install">
        {missing.map((entry) => (
          <ProviderRow key={entry.id} entry={entry} />
        ))}
        <AddAcpAgentRow>Add an ACP agent…</AddAcpAgentRow>
      </SettingSection>
    </>
  );
}

/** The name opens preferences; the primary action stays on this screen. */
function ProviderRow(props: { entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
  const accounts = useAccountViews();
  const own = accounts.data?.filter(
    (account) =>
      account.provider === install.kind &&
      (install.kind !== "acp" || account.acpAgentId === install.acpAgentId),
  );
  return (
    <div role="group" aria-label={install.name} className="py-1">
      <ProviderSetupRow
        columns
        provider={install.kind}
        acpAgentId={install.registry?.agent?.acpAgentId ?? install.acpAgentId}
        instance={install.instance}
        name={install.name}
        missing={isMissing(props.entry)}
        view={view}
        updateAvailable={updateAvailable(props.entry)}
        secondary={
          !isMissing(props.entry) && (
            // Right-aligned on whichever line it lands, so the chevron keeps the row's edge.
            <span className="ml-auto flex items-center gap-3">
              {/* Accounts only where the row has room for them; the provider's page lists them. */}
              <span className="hidden items-center gap-1 @[34rem]:flex">
                {own?.map((account) => (
                  <AccountBadge key={account.id} account={account} focusable />
                ))}
              </span>
              <Tip label={`Open ${install.name}`}>
                <Link
                  to="/settings/providers/$provider"
                  params={{ provider: props.entry.id }}
                  aria-label={`Open ${install.name}`}
                  className="rounded-xs text-subtle-foreground focus-ring"
                >
                  <CaretRightIcon aria-hidden size={14} />
                </Link>
              </Tip>
            </span>
          )
        }
        title={
          <Link
            to="/settings/providers/$provider"
            params={{ provider: props.entry.id }}
            aria-label={install.name}
            className="inline-flex items-center gap-2 font-medium hover:underline"
          >
            {install.name}
            <span className="hidden text-xs font-normal sm:flex text-subtle-foreground">
              {row?.version ?? install.version}
            </span>
          </Link>
        }
      />
    </div>
  );
}
