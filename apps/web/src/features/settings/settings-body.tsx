import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import { Screen } from "@/features/shell/index.ts";
import { useSettingsMachine } from "./machine-scope.tsx";
import { settingsPageOf } from "./settings-pages.ts";

/**
 * One settings page, as the approved Appearance mockup lays it out (docs/design/2026-10-14):
 * the content starts beside the nav, padded 20/28, under a 20/600 page title; groups are
 * uppercase labels over rounded cards of 44px rows. The title row carries the page's controls
 * at its right and, on a Machine page with more than one machine, the machine it edits as a
 * quiet menu ("This Mac ⌄"), as Usage picks its environment. Content rises in when the page
 * or the machine changes.
 */
export function SettingsBody(props: {
  page: string;
  lede?: ReactNode;
  actions?: ReactNode;
  /** The page's controls (a refresh, a scope), at the right of the title row. */
  titleActions?: ReactNode;
  /** The page this one sits under, as a quiet link above the title ("‹ Providers"). */
  back?: ReactNode;
  /** A mark beside the title (a provider's page). */
  icon?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const machinePage = settingsPageOf(pathname)?.group === "machine";
  const { machine, machines } = useSettingsMachine();
  const picker = machinePage && machines.length > 1;
  return (
    // The sidebar already says Settings and the page names itself below: the header keeps only
    // its controls, with the view's name for assistive tech.
    <Screen title={<span className="sr-only">Settings</span>} actions={props.actions}>
      <div className="h-full overflow-auto">
        <div className="@container w-full max-w-[860px] px-5 pt-5 pb-20 sm:px-7">
          {props.back && <div className="mb-1 text-ui">{props.back}</div>}
          <div className="mb-3.5 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
            {props.icon}
            <div className="min-w-0">
              <h2 className="text-xl leading-[26px] font-semibold tracking-[-0.015em]">
                {props.page}
              </h2>
              {props.lede && (
                <div className="mt-0.5 text-ui text-muted-foreground">{props.lede}</div>
              )}
            </div>
            {(picker || props.trailing || props.titleActions) && (
              <div className="ml-auto flex items-center gap-2">
                {picker && <MachineFilter />}
                {props.trailing}
                {props.titleActions}
              </div>
            )}
          </div>
          <div
            // A new page or machine starts its content over, with one short rise.
            key={`${pathname}:${machine?.primary ? "primary" : (machine?.id ?? "")}`}
            className="fx-rise-in"
          >
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
    <FilterMenu
      label="Machine"
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
  );
}
