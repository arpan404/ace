import { compareVersions } from "@ace/ui-core/acp-registry";
import { Link } from "@tanstack/react-router";
import { ProviderSetupRow } from "@/features/provider-setup/index.ts";
import { SettingSection } from "@/components/setting-row.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { AddAcpAgent } from "./add-acp-agent.tsx";
import { RediscoverButton } from "./rediscover-button.tsx";
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
  if (query.isError || !entries)
    return (
      <p role="alert" className="mt-7 text-sm text-muted-foreground">
        Couldn't list providers. Reconnect and check again.
      </p>
    );
  const builtIn = entries.filter((entry) => entry.install.kind !== "acp");
  const installed = builtIn.filter((entry) => !isMissing(entry));
  const missing = builtIn.filter(isMissing);
  const agents = entries.filter((entry) => entry.install.kind === "acp");
  return (
    <>
      <SettingSection label="On this computer" actions={<RediscoverButton />}>
        {installed.length ? (
          installed.map((entry) => <ProviderRow key={entry.id} entry={entry} />)
        ) : (
          <p className="px-4 py-5 text-muted-foreground">
            No coding agents found yet. Install one below, then check again.
          </p>
        )}
      </SettingSection>
      {missing.length > 0 && (
        <SettingSection label="Not installed">
          {missing.map((entry) => (
            <ProviderRow key={entry.id} entry={entry} />
          ))}
        </SettingSection>
      )}
      <SettingSection label="ACP agents" actions={<AddAcpAgent />}>
        {agents.map((entry) => (
          <ProviderRow key={entry.id} entry={entry} />
        ))}
      </SettingSection>
      <p className="mt-6 text-sm text-muted-foreground">
        All accounts and scheduling are in{" "}
        <Link to="/accounts" className="font-medium text-foreground hover:underline">
          Usage &amp; accounts ›
        </Link>
      </p>
    </>
  );
}

/** The name opens preferences; the primary action stays on this screen. */
function ProviderRow(props: { entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
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
        title={
          <Link
            to="/settings/providers/$provider"
            params={{ provider: props.entry.id }}
            className="font-medium hover:underline"
          >
            {install.name}
          </Link>
        }
      />
    </div>
  );
}
