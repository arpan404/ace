import { Link } from "@tanstack/react-router";

const tab =
  "-mb-px border-b-2 border-transparent py-2 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground";

/**
 * Fleet's two views as page tabs over a hairline: Overview (the rows) and Map (the network
 * diagram). Each is its own address, so Back and a shared link land on the same view.
 */
export function FleetTabs() {
  return (
    <nav aria-label="Fleet views" className="flex gap-4.5 border-b border-border">
      <Link
        to="/settings/remote"
        activeOptions={{ exact: true, includeHash: false }}
        className={tab}
      >
        Overview
      </Link>
      <Link to="/settings/remote/map" className={tab}>
        Map
      </Link>
    </nav>
  );
}
