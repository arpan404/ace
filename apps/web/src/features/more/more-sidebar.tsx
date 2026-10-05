import { Link } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { morePages } from "./pages.ts";

/** More's list in the sidebar: the less frequent places. */
export function MoreSidebar() {
  return (
    <ViewSidebar title="More">
      <ul className="flex flex-col gap-px">
        {morePages.map((page) => (
          <li key={page.to}>
            <Link
              to={page.to}
              className="group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-card px-[11px] py-[9px] transition-colors duration-(--dur-1) hover:bg-sidebar-accent data-[status=active]:bg-foreground/8"
            >
              <span className="mt-px grid size-[26px] place-items-center rounded-sm bg-secondary text-muted-foreground group-data-[status=active]:text-foreground">
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
