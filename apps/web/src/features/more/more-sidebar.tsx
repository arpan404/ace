import { Link } from "@tanstack/react-router";
import { useViewListKeys, ViewRowBody, viewRowClass } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { morePages } from "./pages.ts";

/** More's list in the sidebar: the less frequent places. */
export function MoreSidebar() {
  const listKeys = useViewListKeys<HTMLUListElement>();
  return (
    <ViewSidebar title="More">
      <ul className="flex flex-col gap-px" {...listKeys}>
        {morePages.map((page) => (
          <li key={page.to}>
            <Link to={page.to} className={viewRowClass}>
              <ViewRowBody
                icon={page.icon}
                title={page.title}
                description={page.description}
                strong
              />
            </Link>
          </li>
        ))}
      </ul>
    </ViewSidebar>
  );
}
