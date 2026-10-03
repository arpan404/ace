import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { settingsPages, type SettingsPath } from "./settings-pages.ts";

/** Pages that live under another page in the nav (the Theme editor sits under Advanced). */
const parents: Record<string, SettingsPath> = { "/settings/theme-editor": "/settings/advanced" };

/** Settings' second sidebar: the page list. */
export function SettingsNav() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = parents[pathname] ?? pathname;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-5">
      <h2 className="px-2.5 pt-1.5 pb-4 text-lg font-semibold tracking-title text-foreground">
        Settings
      </h2>
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
                    "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground",
                    active &&
                      "bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] font-medium text-foreground",
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
    </div>
  );
}
