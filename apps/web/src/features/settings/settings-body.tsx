import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CaretDownIcon, DevicesIcon } from "@phosphor-icons/react";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import { Screen } from "@/features/shell/index.ts";
import { allMachines, useSettingsMachine } from "./machine-scope.tsx";
import { settingsPageOf, type SettingsGroup } from "./settings-pages.ts";

/**
 * One settings page, cardless like the rest of the app: a centred column, as the thread view
 * and Usage centre theirs, under a 20/600 page title; groups are a section title over hairline
 * rows. Under the title, what the page edits: the environment it edits as a menu to switch it,
 * or "This device". The title row carries the page's controls at its right. Content rises in
 * when the page or the environment changes.
 *
 * Nothing on a page is a card: a group is its title over hairline-separated rows, and groups
 * are set apart by `--settings-group-gap` (see `SettingSection`).
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
  const group = settingsPageOf(pathname)?.group;
  const { machine } = useSettingsMachine();
  return (
    // The sidebar already says Settings and the page names itself below: the header keeps only
    // its controls, with the view's name for assistive tech.
    <Screen title={<span className="sr-only">Settings</span>} actions={props.actions}>
      <div className="h-full overflow-auto">
        <div className="@container mx-auto w-full max-w-[700px] px-5 pt-8 pb-20 sm:px-7">
          {props.back && <div className="mb-1 text-ui">{props.back}</div>}
          {/* The title row is a band of its own: the first group starts a clear step below it. */}
          <div className="mb-7 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
            {props.icon}
            <div className="min-w-0">
              <h2 className="text-xl leading-[26px] font-semibold tracking-[-0.015em]">
                {props.page}
              </h2>
              <PageScope group={group} />
              {props.lede && (
                <div className="mt-0.5 text-ui text-muted-foreground">{props.lede}</div>
              )}
            </div>
            {(props.trailing || props.titleActions) && (
              <div className="ml-auto flex items-center gap-2">
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

/**
 * What a page edits, under its title: the environment picked in the sidebar for a machine page,
 * "This device" for a page this screen keeps whatever environment is picked.
 */
function PageScope(props: { group: SettingsGroup | undefined }) {
  const { machine, machines, choose, all } = useSettingsMachine();
  if (props.group === "device")
    return <p className="mt-0.5 text-ui text-muted-foreground">This device</p>;
  if (props.group !== "machine" || !machine) return null;
  const label = all ? (
    <>
      <DevicesIcon aria-hidden size={14} />
      All machines
    </>
  ) : (
    <>
      <MachineMark icon={machine.icon} primary={machine.primary} />
      {machine.name}
    </>
  );
  if (machines.length < 2)
    return (
      <p className="mt-0.5 flex items-center gap-1.5 text-ui text-muted-foreground">{label}</p>
    );
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Environment: ${all ? "All machines" : machine.name}`}
        className="-ml-1.5 mt-0.5 flex h-6 items-center gap-1.5 rounded-md px-1.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
      >
        {label}
        <CaretDownIcon aria-hidden size={12} className="text-subtle-foreground" />
      </MenuTrigger>
      <MenuContent align="start">
        <MenuRadioGroup
          value={all ? allMachines : machine.id}
          onValueChange={(id: unknown) => {
            if (id === allMachines) return choose(allMachines);
            const next = machines.find((entry) => entry.id === id);
            if (next) choose(next.primary ? undefined : next.id);
          }}
        >
          <MenuRadioItem value={allMachines}>
            <span className="flex min-w-0 items-center gap-2">
              <DevicesIcon aria-hidden size={14} />
              All machines
            </span>
          </MenuRadioItem>
          {machines.map((entry) => (
            <MenuRadioItem key={entry.id} value={entry.id}>
              <span className="flex min-w-0 items-center gap-2">
                <MachineMark icon={entry.icon} primary={entry.primary} />
                <span className="truncate">{entry.name}</span>
                {entry.status !== "online" && (
                  <span className="text-xs text-subtle-foreground">
                    {machineStatus[entry.status].label}
                  </span>
                )}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
