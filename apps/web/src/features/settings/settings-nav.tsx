import { Link } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { settingsPages } from "./settings-pages.ts";

/** Settings' second sidebar: the page list. */
export function SettingsNav() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-5">
      <h2 className="px-2.5 pt-1.5 pb-4 text-lg font-semibold tracking-title text-foreground">
        Settings
      </h2>
      <nav aria-label="Settings pages">
        <ul className="flex flex-col gap-px">
          {settingsPages.map((page) => (
            <li key={page.to}>
              <Link
                to={page.to}
                className="group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] data-[status=active]:font-medium data-[status=active]:text-foreground"
              >
                {({ isActive }) => (
                  <>
                    <Icon icon={page.icon} active={isActive} />
                    {page.title}
                  </>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
