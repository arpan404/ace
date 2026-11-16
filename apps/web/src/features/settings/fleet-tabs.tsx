import { Link } from "@tanstack/react-router";
import { part } from "@/lib/suit-part.ts";

const tab =
  "-mb-px border-b-2 border-transparent py-2 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground";

/** The open view's tab, in the styling contract as in its `aria-current`. */
const selectedTab = { "data-state": "selected" } as const;

/**
 * Fleet's two views as page tabs over a hairline: Overview (the rows) and Map (the network
 * diagram). Each is its own address, so Back and a shared link land on the same view.
 */
export function FleetTabs() {
  return (
    <nav
      aria-label="Fleet views"
      {...part("tabs", undefined, "fleet")}
      className="flex gap-4.5 border-b border-border"
    >
      <Link
        to="/settings/remote"
        activeOptions={{ exact: true, includeHash: false }}
        activeProps={selectedTab}
        {...part("tab")}
        className={tab}
      >
        Overview
      </Link>
      <Link to="/settings/remote/map" activeProps={selectedTab} {...part("tab")} className={tab}>
        Map
      </Link>
    </nav>
  );
}
