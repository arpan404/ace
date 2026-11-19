import { useState } from "react";
import { ProviderListRow } from "@/features/provider-setup/index.ts";
import { SettingNote } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { AcpAgents } from "./acp-registry/registry-section.tsx";
import { listState, latestVersion } from "./provider-list-state.ts";
import { ProvidersGroup } from "./providers-group.tsx";
import {
  isMissing,
  updateAvailable,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";

const toneInk = {
  ready: undefined,
  idle: undefined,
  action: "text-status-needs-you",
  problem: "text-status-failed",
} as const;

/**
 * Settings → Providers: every coding agent on this computer as one row (mark, name, version,
 * its state and accounts in words, the one action it needs), each opening its own page; then
 * the ACP agents ace can install, from the registry, on the page itself.
 */
export function ProviderSettings() {
  const { entries, query } = useProviderEntries();
  // Bumped by Update all; each row with an update waiting runs it.
  const [updateAll, setUpdateAll] = useState(0);
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
  const updates = installed.filter(hasUpdate).length;
  return (
    <>
      <ProvidersGroup
        label="Installed"
        aside={installed.length || undefined}
        actions={
          updates > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setUpdateAll((count) => count + 1)}>
              Update all
            </Button>
          )
        }
      >
        {installed.length ? (
          installed.map((entry) => (
            <InstalledRow key={entry.id} entry={entry} updateAll={updateAll} />
          ))
        ) : (
          <SettingNote>No coding agents on this computer yet.</SettingNote>
        )}
      </ProvidersGroup>
      <AcpAgents entries={entries} />
    </>
  );
}

const hasUpdate = (entry: ProviderEntry) =>
  updateAvailable(entry) || entry.view?.primary === "update";

function InstalledRow(props: { entry: ProviderEntry; updateAll: number }) {
  const { install, row, view } = props.entry;
  const state = listState(props.entry);
  return (
    <ProviderListRow
      installed
      provider={install.kind}
      acpAgentId={install.registry?.agent?.acpAgentId ?? install.acpAgentId}
      instance={install.instance}
      name={install.name}
      missing={false}
      readiness={view}
      updateAvailable={updateAvailable(props.entry)}
      latest={latestVersion(props.entry)}
      page={props.entry.id}
      version={row?.version ?? install.version}
      updateAll={props.updateAll}
      sub={
        <>
          <span className={toneInk[state.tone]}>{state.text}</span>
          {state.accounts && <> · {state.accounts}</>}
        </>
      }
    />
  );
}
