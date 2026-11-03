import { Link, useRouterState } from "@tanstack/react-router";
import { BellIcon, CircleDashedIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { PanelRowBody, panelRow } from "@/components/ui/panel.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { projectsParam, rememberedProjects } from "@/lib/forge-projects.ts";
import { useLayout } from "@/lib/layout.tsx";
import { PanelHeader } from "./view-frame.tsx";

const places = [
  { to: "/inbox", label: "Inbox", icon: BellIcon },
  { to: "/pulls", label: "Pull requests", icon: GitPullRequestIcon },
  { to: "/issues", label: "Issues", icon: CircleDashedIcon },
] as const;

type Place = (typeof places)[number]["to"];

/**
 * The list a Code review page belongs to: its own path's, or, for a pull request or issue opened from
 * the Inbox (`back` names the list it came from), the Inbox.
 */
function forgePlaceOf(pathname: string, back: unknown): Place | undefined {
  if (typeof back === "string" && back.startsWith("/inbox")) return "/inbox";
  return places.find((place) => pathname === place.to || pathname.startsWith(`${place.to}/`))?.to;
}

/**
 * Code review's panel: its three pages, Inbox, Pull requests and Issues, as panel rows, the one the
 * page belongs to selected (a pull request's or issue's page included). The pages fill the main
 * column and carry no switch of their own: this panel is the way between them. Each link carries
 * the projects picked, so moving between the three keeps them.
 */
export function ForgePanel() {
  const current = useRouterState({
    select: (state) => {
      const search: Record<string, unknown> = state.location.search;
      return forgePlaceOf(state.location.pathname, search["back"]);
    },
  });
  const keys = useViewListKeys<HTMLUListElement>();
  // The address's pick when it names one, else the one remembered: a pick navigates, so the
  // links follow it.
  const routed = useRouterState({
    select: (state) => {
      const search: Record<string, unknown> = state.location.search;
      const value = search["projects"];
      return Array.isArray(value) && value.every((id) => typeof id === "string")
        ? value.join("\n")
        : undefined;
    },
  });
  const remembered = rememberedProjects(useLayout().storage);
  const projects = projectsParam(
    routed === undefined ? remembered : routed ? routed.split("\n") : [],
  );
  return (
    <aside aria-label="Code review" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Code review" />
      <ul {...keys} className="flex flex-col gap-px px-2 pb-4">
        {places.map((place) => (
          <li key={place.to}>
            <Link
              to={place.to}
              search={{ projects }}
              // Only the list itself: a pull request's page belongs to the list it came from.
              activeOptions={{ exact: true, includeSearch: false }}
              aria-current={current === place.to ? "page" : undefined}
              {...panelRow()}
            >
              <PanelRowBody icon={place.icon} title={place.label} />
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
