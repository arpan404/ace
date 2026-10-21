import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import { Screen } from "@/features/shell/index.ts";
import { useSettingsMachine } from "./machine-scope.tsx";
import { settingsPageOf } from "./settings-pages.ts";

/**
 * One settings page, laid out like the rest of the app. The header names it ("Settings /
 * Agents", as a thread's header reads "project / title"). Under it, a quiet toolbar as on
 * Usage: on a Machine page the machine it edits ("This Mac ⌄", once there is more than one),
 * and the page's own controls at the right. Then the conversation's column with nothing drawn
 * around it. A page about one thing (a provider) leads with its mark and name instead, since
 * that row carries its state and the action it needs. Content rises in when the page or the
 * machine changes, so a switch reads as a switch.
 */
export function SettingsBody(props: {
  page: string;
  lede?: ReactNode;
  actions?: ReactNode;
  /** The page's controls (a refresh, a scope): at the toolbar's right, or beside the mark. */
  titleActions?: ReactNode;
  /** The page this one sits under, as a link ("Providers" over a provider). */
  back?: ReactNode;
  /** A mark beside the name (a provider's page): the page then leads with mark and name. */
  icon?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const machinePage = settingsPageOf(pathname)?.group === "machine";
  const { machine, machines } = useSettingsMachine();
  const identity = props.icon !== undefined;
  const picker = machinePage && machines.length > 1;
  const tools = !identity && (props.trailing || props.titleActions);
  return (
    <Screen crumb={props.back ?? "Settings"} title={props.page} actions={props.actions}>
      <div className="h-full overflow-auto">
        <div className="@container mx-auto w-full max-w-(--column) px-5 pb-20 sm:px-8">
          {(picker || tools) && (
            <div className="flex min-h-11 flex-wrap items-center gap-2 pt-3">
              {picker && <MachineFilter />}
              {tools && (
                <div className="ml-auto flex items-center gap-2">
                  {props.trailing}
                  {props.titleActions}
                </div>
              )}
            </div>
          )}
          <div
            // A new page or machine starts its content over, with one short rise.
            key={`${pathname}:${machine?.primary ? "primary" : (machine?.id ?? "")}`}
            className="fx-rise-in pt-8 [&>section:first-child]:mt-0"
          >
            {identity ? (
              <div className="flex items-center gap-3">
                {props.icon}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium">{props.page}</p>
                  {props.lede && <div className="text-ui text-muted-foreground">{props.lede}</div>}
                </div>
                {props.trailing}
                {props.titleActions && <div className="shrink-0">{props.titleActions}</div>}
              </div>
            ) : (
              props.lede && <p className="text-ui text-muted-foreground">{props.lede}</p>
            )}
            {props.children}
          </div>
        </div>
      </div>
    </Screen>
  );
}

/** The machine a Machine page edits, as Usage picks its environment: a quiet text menu. */
function MachineFilter() {
  const { machine, machines, choose } = useSettingsMachine();
  return (
    <div className="-ml-2">
      <FilterMenu
        label="Machine"
        align="start"
        value={machine?.id ?? ""}
        options={machines.map((entry) => ({
          value: entry.id,
          label:
            entry.status === "online"
              ? entry.name
              : `${entry.name} · ${machineStatus[entry.status].label}`,
        }))}
        onValueChange={(id) => {
          const next = machines.find((entry) => entry.id === id);
          choose(next && !next.primary ? next.id : undefined);
        }}
      />
    </div>
  );
}
