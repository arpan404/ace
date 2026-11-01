import { Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import {
  panelLabel,
  PanelRowBody,
  panelRow,
  PanelSearch,
  PanelSection,
} from "@/components/ui/panel.tsx";
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

const groupOrder: readonly SettingsGroup[] = ["device", "machine", "network"];

/**
 * Settings' pages as links, the current one marked: under "This device" the pages this screen
 * keeps, then under "Environment" the pages a machine keeps, then Fleet. Also the phone's
 * Settings page.
 */
export function SettingsPageLinks(props: { pages?: readonly SettingsPath[] }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = settingsPageOf(pathname)?.to;
  const listKeys = useViewListKeys<HTMLDivElement>();
  const pages = props.pages
    ? visibleSettingsPages().filter((page) => props.pages?.includes(page.to))
    : visibleSettingsPages();
  return (
    <div className="flex flex-col" {...listKeys}>
      {groupOrder.map((group) => {
        const inGroup = pages.filter((page) => page.group === group);
        if (!inGroup.length) return null;
        const title = settingsGroupTitles[group];
        return title ? (
          <PanelSection key={group} label={title}>
            <PageList pages={inGroup} current={current} />
          </PanelSection>
        ) : (
          <section key={group} aria-label="Network" className="mt-5 first:mt-1">
            <ul className="flex flex-col gap-px">
              <PageList pages={inGroup} current={current} />
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** A group's pages, as panel rows: the open one on the current row's fill. */
function PageList(props: { pages: readonly SettingsPage[]; current: string | undefined }) {
  return props.pages.map((page) => (
    <li key={page.to}>
      <Link
        to={page.to}
        aria-current={props.current === page.to ? "page" : undefined}
        {...panelRow()}
      >
        <PanelRowBody icon={page.icon} title={page.title} />
      </Link>
    </li>
  ));
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
        <PanelSearch
          label="Search settings"
          placeholder="Search settings"
          value={query}
          onValueChange={setQuery}
        />
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
        <section aria-label="Matching settings" className="mt-5">
          <h3 className={panelLabel}>Settings</h3>
          <ul className="flex flex-col gap-px">
            {found.map((entry) => (
              <li key={entry.id}>
                <Link
                  to={entry.page}
                  hash={entry.id}
                  {...panelRow("h-auto flex-col items-start gap-0 py-1.5")}
                >
                  <span data-view-row-title="">{entry.title}</span>
                  <span className="text-sm text-muted-foreground">{pageTitle(entry.page)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </ViewSidebar>
  );
}
