import { CaretRightIcon } from "@phosphor-icons/react";
import { useAccountViews } from "@/lib/account-views.ts";
import { AccountBadge } from "@/components/ui/provider-account-icon.tsx";
import { compareVersions } from "@ace/ui-core/acp-registry";
import { Link } from "@tanstack/react-router";
import { ProviderSetupRow } from "@/features/provider-setup/index.ts";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { AddAcpAgent } from "./add-acp-agent.tsx";
import { isMissing, useProviderEntries, type ProviderEntry } from "./provider-entries.ts";

/**
 * Settings → Providers: every coding agent on this computer as one calm row (its mark, its name,
 * one status line and at most the one action it needs), each opening its own page. Agents that
 * aren't installed and ACP agents sit in their own groups below.
 */
export function ProviderSettings() {
  const { entries, query } = useProviderEntries();
  if (query.isPending)
    return <ListSkeleton label="providers" shape="row" rows={5} className="mt-7" />;
  if (!entries)
    return (
      <p role="alert" className="mt-7 text-sm text-muted-foreground">
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
          <p className="px-4 py-5 text-muted-foreground">
            No coding agents found yet. Install one below, then check again.
          </p>
        )}
      </SettingSection>
      {missing.length > 0 && (
        <SettingSection label="Available to install">
          {missing.map((entry) => (
            <ProviderRow key={entry.id} entry={entry} />
          ))}
        </SettingSection>
      )}
      <div className="mt-2">
        <AddAcpAgent>Add an ACP agent…</AddAcpAgent>
      </div>
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
    <div role="group" aria-label={install.name}>
      <ProviderSetupRow
        provider={install.kind}
        acpAgentId={install.registry?.agent?.acpAgentId ?? install.acpAgentId}
        instance={install.instance}
        name={install.name}
        missing={isMissing(props.entry)}
        view={view}
        updateAvailable={
          row?.updateAvailable ??
          (!!install.registry?.agent &&
            compareVersions(install.registry.agent.version, install.registry.version) > 0)
        }
        secondary={
          !isMissing(props.entry) && (
            <>
              <span className="flex items-center gap-1">
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
            </>
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
