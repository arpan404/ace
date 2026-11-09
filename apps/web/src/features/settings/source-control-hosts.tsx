import type { ForgeKind } from "@ace/protocol/forge";
import type { SourceControlPreferences } from "@ace/protocol";
import { defaultForgeHost, forgeNames, forgeOrder, hostForge } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ForgeIcon } from "@/components/ui/forge-icon.tsx";
import { SettingAction, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { settingRow } from "./settings-index.ts";

/** A provider's name after its bare mark, as a row title. */
export function ForgeTitle(props: { forge: ForgeKind; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <ForgeIcon forge={props.forge} size={16} decorative />
      {props.children ?? forgeNames[props.forge]}
    </span>
  );
}

/**
 * Settings › Source control › Git hosts: every provider in settings order, one row per saved
 * host, and an Add row for a provider with none. Each saved host is managed on its own; the
 * shown host is the one whose status the page reads.
 */
export function SourceControlHosts(props: {
  preferences: SourceControlPreferences | undefined;
  disabled: boolean;
  onAdd(forge: ForgeKind): void;
  onManage(host: string): void;
  onShow(host: string): void;
  onRemove(host: string): void;
}) {
  const saved = props.preferences?.hosts ?? [];
  return (
    <SettingSection label="Git hosts" anchor={settingRow("sourceControl.hosts").id}>
      {forgeOrder.flatMap((forge) => {
        const hosts = saved.filter((entry) => hostForge(entry) === forge);
        if (!hosts.length)
          return [
            <SettingRow
              key={forge}
              title={<ForgeTitle forge={forge} />}
              description={defaultForgeHost(forge) || "Self-hosted"}
              inline
            >
              <Button
                variant="secondary"
                size="sm"
                disabled={props.disabled}
                aria-label={`Add ${forgeNames[forge]} host`}
                onClick={() => props.onAdd(forge)}
              >
                Add host
              </Button>
            </SettingRow>,
          ];
        return hosts.map((entry) => {
          const shown = entry.host === props.preferences?.host;
          return (
            <SettingRow
              key={entry.host}
              title={<ForgeTitle forge={forge} />}
              description={[entry.host, entry.account, shown && "Status shown below"]
                .filter(Boolean)
                .join(" · ")}
              inline
            >
              {!shown && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={props.disabled}
                  aria-label={`Show status for ${entry.host}`}
                  onClick={() => props.onShow(entry.host)}
                >
                  Show status
                </Button>
              )}
              {saved.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={props.disabled}
                  aria-label={`Remove ${entry.host}`}
                  onClick={() => props.onRemove(entry.host)}
                >
                  Remove
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={props.disabled}
                aria-label={`Manage ${entry.host}`}
                onClick={() => props.onManage(entry.host)}
              >
                Manage
              </Button>
            </SettingRow>
          );
        });
      })}
      {/* A second host of a provider already listed: GitHub Enterprise beside github.com. */}
      <SettingAction disabled={props.disabled} onClick={() => props.onAdd("github")}>
        Add another host
      </SettingAction>
    </SettingSection>
  );
}
