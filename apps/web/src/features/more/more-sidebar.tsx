import { ChartBarIcon, FilesIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { IconGlyph } from "@/components/icon.tsx";
import { Icon } from "@/components/icon.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";

const pages: readonly {
  to: "/more/accounts" | "/more/files" | "/more/search";
  title: string;
  description: string;
  icon: IconGlyph;
}[] = [
  {
    to: "/more/accounts",
    title: "Usage & accounts",
    description: "Quota per account window, scheduling",
    icon: ChartBarIcon,
  },
  {
    to: "/more/files",
    title: "Files",
    description: "Changed files across threads",
    icon: FilesIcon,
  },
  {
    to: "/more/search",
    title: "Search",
    description: "Full-text search in every thread",
    icon: MagnifyingGlassIcon,
  },
];

/** More's second sidebar: the less frequent places. */
export function MoreSidebar() {
  return (
    <ViewSidebar title="More">
      <ul className="flex flex-col gap-px">
        {pages.map((page) => (
          <li key={page.to}>
            <Link
              to={page.to}
              className="group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-card px-[11px] py-[9px] transition-colors duration-(--dur-1) hover:bg-sidebar-accent data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]"
            >
              <span className="mt-px grid size-[26px] place-items-center rounded-[7px] bg-secondary text-muted-foreground group-data-[status=active]:text-foreground">
                <Icon icon={page.icon} />
              </span>
              <span>
                <span className="block text-ui leading-[1.3] font-medium text-foreground">
                  {page.title}
                </span>
                <span className="mt-0.5 block text-[12px] leading-[1.35] text-subtle-foreground">
                  {page.description}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </ViewSidebar>
  );
}
