import { Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { pageTitle, searchSettings } from "./settings-index.ts";
import { settingsPages, type SettingsPath } from "./settings-pages.ts";

/** Pages that live under another page in the nav (the Theme editor sits under Appearance). */
const parents: Record<string, SettingsPath> = { "/settings/theme-editor": "/settings/appearance" };

const rowClass =
  "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-ring-inset";

/** Settings' pages as links; the current one is marked. Also the phone's Settings page. */
export function SettingsPageLinks(props: { pages?: readonly SettingsPath[] }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = parents[pathname] ?? pathname;
  const listKeys = useViewListKeys<HTMLUListElement>();
  const pages = props.pages
    ? settingsPages.filter((page) => props.pages?.includes(page.to))
    : settingsPages;
  return (
    <ul className="flex flex-col gap-px" {...listKeys}>
      {pages.map((page) => {
        const active = current === page.to;
        return (
          <li key={page.to}>
            <Link
              to={page.to}
              data-view-row=""
              aria-current={active ? "page" : undefined}
              className={cn(
                rowClass,
                active && "bg-foreground/10 font-medium text-foreground",
              )}
            >
              <Icon icon={page.icon} active={active} />
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
  const pages = settingsPages
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
          <h3 className="px-2.5 pb-1.5 text-sm font-medium text-muted-foreground">Settings</h3>
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
