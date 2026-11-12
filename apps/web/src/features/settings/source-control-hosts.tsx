import type { ForgeKind } from "@ace/protocol/forge";
import type { SourceControlPreferences } from "@ace/protocol";
import { forgeNames, forgeOrder, hostForge } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { ForgeIcon } from "@/components/ui/forge-icon.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { settingRow } from "./settings-index.ts";
import {
  ShownHostNotes,
  shownHostDescription,
  type ShownHostStatus,
} from "./source-control-status.tsx";

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
 * Settings › Source control › Git hosts: one row per saved host in provider order, and Add host
 * in the heading for a provider with none yet, or another host of any. Each saved host is
 * managed on its own; the shown host is the one whose status the page reads, and its row
 * carries that status.
 */
export function SourceControlHosts(props: {
  preferences: SourceControlPreferences | undefined;
  shown: ShownHostStatus;
  disabled: boolean;
  onAdd(forge: ForgeKind): void;
  onManage(host: string): void;
  onShow(host: string): void;
  onRemove(host: string): void;
  onRescan(): void;
}) {
  const saved = props.preferences?.hosts ?? [];
  const added = forgeOrder.flatMap((forge) =>
    saved.filter((entry) => hostForge(entry) === forge).map((entry) => ({ forge, entry })),
  );
  const missing = forgeOrder.filter((forge) => !added.some((host) => host.forge === forge));
  return (
    <SettingSection
      label="Git hosts"
      anchor={settingRow("sourceControl.hosts").id}
      actions={<AddHostMenu missing={missing} disabled={props.disabled} onAdd={props.onAdd} />}
    >
      {!props.preferences && props.shown.loading && (
        <SettingRow title={<Skeleton className="w-24" />} inline />
      )}
      {props.preferences && !added.length && <SettingNote>No Git hosts yet.</SettingNote>}
      {added.map(({ forge, entry }) => {
        const shown = entry.host === props.preferences?.host;
        return (
          <SettingRow
            key={entry.host}
            title={<ForgeTitle forge={forge} />}
            description={
              shown
                ? shownHostDescription(entry.host, props.shown)
                : [entry.host, entry.account].filter(Boolean).join(" · ")
            }
            inline
          >
            {shown && props.shown.canRescan && (
              <Button variant="ghost" size="sm" disabled={props.disabled} onClick={props.onRescan}>
                Rescan
              </Button>
            )}
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
      })}
      <ShownHostNotes shown={props.shown} />
    </SettingSection>
  );
}

/** Add host: each provider with no saved host, then another host of any (GitHub Enterprise). */
function AddHostMenu(props: {
  missing: readonly ForgeKind[];
  disabled: boolean;
  onAdd(forge: ForgeKind): void;
}) {
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        className={buttonVariants({ size: "sm", variant: "secondary" })}
      >
        Add host
      </MenuTrigger>
      <MenuContent align="end">
        {props.missing.map((forge) => (
          <MenuItem
            key={forge}
            icon={<ForgeIcon forge={forge} size={14} decorative />}
            onClick={() => props.onAdd(forge)}
          >
            {forgeNames[forge]}
          </MenuItem>
        ))}
        {props.missing.length > 0 && <MenuSeparator />}
        <MenuItem onClick={() => props.onAdd("github")}>Another host…</MenuItem>
      </MenuContent>
    </Menu>
  );
}
