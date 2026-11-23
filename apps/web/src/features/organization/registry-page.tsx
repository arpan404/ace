import { registryFailure, registryVersionRow } from "@ace/ui-core/market";
import type { AceOrgSpace } from "@ace/protocol/ace-org";
import type { RegistryAdminEntry } from "@ace/protocol/marketplace";
import { useState } from "react";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useOrgRegistry, useOrgRegistryWithdraw } from "@/features/marketplace/index.ts";
import { useOpenMarket } from "@/lib/open-market.ts";
import { WithdrawDialog, type Withdrawing } from "./registry-withdraw.tsx";

/**
 * Settings › Organization › Registry (ADR 0206 §5, amendment 5): the organization's private
 * packages, each version with its state and scan, read with the person's own grant through this
 * window's machine. Withdraw asks first, with a reason, and waits for the registry's signer.
 * Every version is signed with the organization's own key, on a machine its owners choose;
 * ace's servers never hold it.
 */
export function RegistryPage(props: { org: AceOrgSpace }) {
  const openMarket = useOpenMarket();
  const { id, name } = props.org;
  const registry = useOrgRegistry(id);
  const withdraw = useOrgRegistryWithdraw(id);
  const [withdrawing, setWithdrawing] = useState<Withdrawing>();
  const [error, setError] = useState("");
  const entries = registry.data?.entries ?? [];
  return (
    <>
      <SettingSection
        label="Private registry"
        anchor="org.registry"
        note={`Bots, skills and plugins only ${name}'s members can find and install.`}
      >
        {registry.isPending && <SettingNote>Reading {name}'s registry…</SettingNote>}
        {registry.isError && (
          <SettingNote role="alert" className="text-destructive">
            {registryFailure(registry.error)}
          </SettingNote>
        )}
        {registry.isSuccess && entries.length === 0 && (
          <SettingNote>Nothing is published to {name}'s registry yet.</SettingNote>
        )}
        {entries.map((entry) => (
          <Entry
            key={`${entry.type}/${entry.name}`}
            entry={entry}
            busy={withdraw.isPending}
            onWithdraw={(version) =>
              setWithdrawing({
                title: entry.title,
                version,
                run: (reason) => {
                  setError("");
                  withdraw.mutate(
                    { type: entry.type, name: entry.name, version, reason },
                    { onError: (failure) => setError(registryFailure(failure)) },
                  );
                },
              })
            }
          />
        ))}
        {error && (
          <SettingNote role="alert" className="text-destructive">
            {error}
          </SettingNote>
        )}
        <SettingRow
          title="Publish a package"
          description="Scanned like every package. It's offered once the organization's key signs it."
          inline
        >
          <Button size="sm" variant="ghost" onClick={() => openMarket("publish")}>
            Publish
          </Button>
        </SettingRow>
      </SettingSection>
      <SettingSection label="Signing key" anchor="org.registry.key">
        <SettingRow
          title="Kept on one machine"
          description="An owner chooses it, ideally a host, so it signs while people sleep. Each device asks once before it trusts the key."
        />
      </SettingSection>
      <WithdrawDialog withdrawing={withdrawing} onDone={() => setWithdrawing(undefined)} />
    </>
  );
}

function Entry(props: {
  entry: RegistryAdminEntry;
  busy: boolean;
  onWithdraw(version: string): void;
}) {
  const { entry } = props;
  return (
    <div className="flex flex-col py-2">
      <span className="text-ui font-medium text-foreground">{entry.title}</span>
      <SettingList aria-label={`${entry.title} versions`}>
        {entry.versions.map((version) => {
          const row = registryVersionRow(version);
          return (
            <SettingListItem key={version.version} className="gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui text-foreground tabular-nums">{version.version}</span>
                <span className="truncate text-xs text-subtle-foreground">
                  {`${row.state} · ${row.scan}`}
                </span>
                {row.detail && (
                  <span className="truncate text-xs text-subtle-foreground">{row.detail}</span>
                )}
              </span>
              {row.canWithdraw && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => props.onWithdraw(version.version)}
                >
                  Withdraw
                </Button>
              )}
            </SettingListItem>
          );
        })}
      </SettingList>
    </div>
  );
}
