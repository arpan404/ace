import { ClockIcon, CubeIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { pageTitle, searchSettings } from "./settings-index.ts";
import { visibleSettingsPages, type SettingsPath } from "./settings-pages.ts";

/** The nav entry a page belongs to: itself, or the page it's a sub-page of. */
function navPage(pathname: string): string {
  if (pathname.startsWith("/settings/providers/")) return "/settings/providers";
  return pathname;
}

const rowClass =
  "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-ring-inset";

/** Settings' pages as links; the current one is marked. Also the phone's Settings page. */
export function SettingsPageLinks(props: { pages?: readonly SettingsPath[] }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = navPage(pathname);
  const listKeys = useViewListKeys<HTMLUListElement>();
  const pages = props.pages
    ? visibleSettingsPages().filter((page) => props.pages?.includes(page.to))
    : visibleSettingsPages();
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
              className={cn(rowClass, active && "bg-foreground/10 font-medium text-foreground")}
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

/** Automations and Skills: sections listed with Settings' pages, each with its own list. */
export type SettingsSection = "/automations" | "/skills";
const sections: readonly { to: SettingsSection; title: string; icon: IconGlyph }[] = [
  { to: "/automations", title: "Automations", icon: ClockIcon },
  { to: "/skills", title: "Skills", icon: CubeIcon },
];

/**
 * Automations and Skills under Settings' pages. The open section's own list (its automations, the
 * skills catalog) sits right under its link, so the sidebar keeps one shape for all three.
 */
function SectionLinks(props: {
  query: string;
  open?: { to: SettingsSection; list: ReactNode } | undefined;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const shown = sections.filter((section) => section.title.toLowerCase().includes(props.query));
  if (!shown.length) return null;
  return (
    <ul aria-label="Sections" className="mt-3 flex flex-col gap-px">
      {shown.map((section) => {
        const active = pathname === section.to || pathname.startsWith(`${section.to}/`);
        return (
          <li key={section.to}>
            <Link
              to={section.to}
              aria-current={active ? "page" : undefined}
              className={cn(rowClass, active && "bg-foreground/10 font-medium text-foreground")}
            >
              <Icon icon={section.icon} active={active} />
              {section.title}
            </Link>
            {props.open?.to === section.to && (
              <aside aria-label={section.title} className="mt-1 flex flex-col">
                {props.open.list}
              </aside>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Settings' list in the sidebar: its pages, Automations and Skills, and a filter that finds
 * single settings. In a section, `section` is that section's own list, shown under its link.
 */
export function SettingsNav(props: {
  section?: { to: SettingsSection; list: ReactNode } | undefined;
}) {
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
        <SectionLinks query={text} open={props.section} />
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
