import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { settingsPages, type SettingsPath } from "./settings-pages.ts";

/** Pages that live under another page in the nav (the Theme editor sits under Advanced). */
const parents: Record<string, SettingsPath> = { "/settings/theme-editor": "/settings/advanced" };

/** Settings' list in the sidebar: its pages. */
export function SettingsNav() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = parents[pathname] ?? pathname;
  return (
    <ViewSidebar title="Settings">
      <nav aria-label="Settings pages">
        <ul className="flex flex-col gap-px">
          {settingsPages.map((page) => {
            const active = current === page.to;
            return (
              <li key={page.to}>
                <Link
                  to={page.to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground",
                    active && "bg-selected font-medium text-foreground",
                  )}
                >
                  <Icon icon={page.icon} active={active} />
                  {page.title}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </ViewSidebar>
  );
}
