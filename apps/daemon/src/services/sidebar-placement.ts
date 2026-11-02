import { SidebarPlacement, followSeenBaseline, type SidebarSort } from "../sidebar-placement.ts";
import type { ServiceContext } from "./types.ts";

const sorts: readonly SidebarSort[] = ["activity", "created", "manual"];
const sortOf = (value: unknown): SidebarSort => sorts.find((sort) => sort === value) ?? "activity";

/**
 * Places listed threads (ADR 0107) under the person's sort (`threads.sortBy`, global) and the
 * daemon's seen baseline (the Activity read cursor's `before`, kept current as it moves), so
 * every client sees one placement. A sort or baseline change re-places every open thread list.
 */
export async function startSidebarPlacement(
  context: Pick<ServiceContext, "store" | "services" | "now"> & {
    resources: Pick<ServiceContext["resources"], "own">;
  },
): Promise<void> {
  const { store, services, now, resources } = context;
  const placement = new SidebarPlacement(store.sidebarToken(), now);
  // Follows "Mark all read" live, as a restart reads its stored cursor.
  if (services.activityReads) resources.own(followSeenBaseline(placement, services.activityReads));
  services.sidebarPlacement = placement;
  const settings = services.settings;
  if (!settings) return;
  const release = await settings.subscribe(
    { keys: ["threads.sortBy"], scope: {} },
    (notification) => {
      if (notification.type !== "changed") return;
      const entry = notification.entries.find((each) => each.key === "threads.sortBy");
      if (entry) placement.setSort(sortOf(entry.value));
    },
  );
  resources.own(release);
  placement.setSort(sortOf((await settings.get("threads.sortBy")).value));
}
