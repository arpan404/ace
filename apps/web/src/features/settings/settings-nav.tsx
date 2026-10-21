import { Link, useLocation } from "@tanstack/react-router";
import { useState, type ComponentProps } from "react";
import { CaretUpDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { machineStatus } from "@/lib/machine-status.ts";
import { Dot } from "@/components/ui/dot.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import type { MachineStatus } from "@/lib/machines.ts";
import { useSettingsMachine } from "./machine-scope.tsx";
import { Icon } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { pageTitle, searchSettings } from "./settings-index.ts";
import {
  settingsGroupTitles,
  settingsPageOf,
  visibleSettingsPages,
  type SettingsGroup,
  type SettingsPage,
  type SettingsPath,
} from "./settings-pages.ts";

const rowClass =
  "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-ring-inset";

const groupOrder: readonly SettingsGroup[] = ["machine", "device", "network"];

/**
 * Settings' pages as links, the current one marked. The environment switcher heads the pages
 * that belong to a machine; "This device" holds the pages that stay with this screen whatever
 * environment is picked; Machines and devices closes the list. Also the phone's Settings page.
 */
export function SettingsPageLinks(props: { pages?: readonly SettingsPath[] }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = settingsPageOf(pathname)?.to;
  const listKeys = useViewListKeys<HTMLDivElement>();
  const pages = props.pages
    ? visibleSettingsPages().filter((page) => props.pages?.includes(page.to))
    : visibleSettingsPages();
  return (
    <div className="flex flex-col gap-4" {...listKeys}>
      {groupOrder.map((group) => {
        const inGroup = pages.filter((page) => page.group === group);
        if (!inGroup.length) return null;
        const title = settingsGroupTitles[group];
        return (
          <section
            key={group}
            aria-label={title ?? (group === "machine" ? "Environment" : "Network")}
          >
            {group === "machine" && !props.pages && <EnvironmentSwitcher />}
            {title && (
              <h3 className="flex h-6 items-center px-2.5 text-xs font-medium text-subtle-foreground">
                {title}
              </h3>
            )}
            <PageList pages={inGroup} current={current} />
          </section>
        );
      })}
    </div>
  );
}

const dotTone = {
  online: "done",
  connecting: "working",
  offline: "idle",
  auth_failed: "failed",
} as const satisfies Record<MachineStatus, ComponentProps<typeof Dot>["tone"]>;

/**
 * The environment the pages under it edit: its live state and name, and the others to switch
 * to. With one machine it only names it.
 */
function EnvironmentSwitcher() {
  const { machine, machines, choose } = useSettingsMachine();
  if (!machine) return null;
  const label = (
    <>
      <Dot tone={dotTone[machine.status]} label={machineStatus[machine.status].label} />
      <span className="min-w-0 flex-1 truncate text-left">{machine.name}</span>
    </>
  );
  const frame =
    "mb-1.5 flex h-9 w-full items-center gap-2.5 rounded-md border border-border px-2.5 text-ui font-medium text-foreground";
  if (machines.length < 2) return <div className={frame}>{label}</div>;
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Environment: ${machine.name}`}
        className={cn(
          frame,
          "transition-colors duration-(--motion-fast) focus-ring hover:bg-accent aria-expanded:bg-accent",
        )}
      >
        {label}
        <CaretUpDownIcon aria-hidden size={14} className="text-subtle-foreground" />
      </MenuTrigger>
      <MenuContent align="start" className="w-(--anchor-width)">
        <MenuRadioGroup
          value={machine.id}
          onValueChange={(id: unknown) => {
            const next = machines.find((entry) => entry.id === id);
            if (next) choose(next.primary ? undefined : next.id);
          }}
        >
          {machines.map((entry) => (
            <MenuRadioItem key={entry.id} value={entry.id}>
              <span className="flex min-w-0 items-center gap-2">
                <Dot tone={dotTone[entry.status]} />
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

function PageList(props: { pages: readonly SettingsPage[]; current: string | undefined }) {
  return (
    <ul className="flex flex-col gap-px">
      {props.pages.map((page) => {
        const active = props.current === page.to;
        return (
          <li key={page.to}>
            <Link
              to={page.to}
              data-view-row=""
              aria-current={active ? "page" : undefined}
              className={cn(rowClass, active && "bg-sidebar-accent font-medium text-foreground")}
            >
              {/* Icons stay outlined: the row's fill and text say which page is open. */}
              <Icon
                icon={page.icon}
                className={
                  active
                    ? "text-foreground"
                    : "text-subtle-foreground group-hover:text-muted-foreground"
                }
              />
              {page.title}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Settings' list in the sidebar: its pages, and a filter that finds single settings. */
export function SettingsNav() {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const found = searchSettings(query);
  const pages = visibleSettingsPages()
    .filter(
      (page) =>
        page.title.toLowerCase().includes(text) || found.some((entry) => entry.page === page.to),
    )
    .map((page) => page.to);
  return (
    <ViewSidebar
      title="Settings"
      toolbar={
        <div className="shrink-0 pr-2.5 pb-2 pl-3">
          <SearchField
            label="Search settings"
            placeholder="Search settings"
            value={query}
            onValueChange={setQuery}
            className="bg-sidebar-accent"
          />
        </div>
      }
    >
      <nav aria-label="Settings pages">
        {!text ? (
          <SettingsPageLinks />
        ) : pages.length ? (
          <SettingsPageLinks pages={pages} />
        ) : (
          <EmptyState variant="inline" title="No matching settings" />
        )}
      </nav>
      {found.length > 0 && (
        <section aria-label="Matching settings" className="mt-4">
          <h3 className="flex h-6 items-center px-2.5 text-2xs font-medium tracking-[0.04em] text-subtle-foreground uppercase">
            Settings
          </h3>
          <ul className="flex flex-col gap-px">
            {found.map((entry) => (
              <li key={entry.id}>
                <Link
                  to={entry.page}
                  hash={entry.id}
                  className={cn(rowClass, "h-auto flex-col items-start gap-0 py-1.5")}
                >
                  <span className="text-foreground">{entry.title}</span>
                  <span className="text-sm">{pageTitle(entry.page)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </ViewSidebar>
  );
}
