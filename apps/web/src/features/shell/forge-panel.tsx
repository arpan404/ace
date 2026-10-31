import { Link, useRouterState } from "@tanstack/react-router";
import { BellIcon, CircleDashedIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import {
  CompactViewRowBody,
  compactViewRowClass,
  useViewListKeys,
} from "@/components/ui/view-row.tsx";
import { PanelHeader } from "./view-frame.tsx";

const places = [
  { to: "/inbox", label: "Inbox", icon: BellIcon },
  { to: "/pulls", label: "Pull requests", icon: GitPullRequestIcon },
  { to: "/issues", label: "Issues", icon: CircleDashedIcon },
] as const;

/**
 * GitHub's panel: its three pages, Inbox, Pull requests and Issues, as view rows, the open one
 * selected. The pages themselves fill the main column.
 */
export function ForgePanel() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const keys = useViewListKeys<HTMLUListElement>();
  return (
    <aside aria-label="GitHub" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="GitHub" />
      <ul {...keys} className="flex flex-col gap-px px-2 pb-4">
        {places.map((place) => (
          <li key={place.to}>
            <Link
              to={place.to}
              aria-current={pathname.startsWith(place.to) ? "page" : undefined}
              className={compactViewRowClass}
            >
              <CompactViewRowBody icon={place.icon} title={place.label} />
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
