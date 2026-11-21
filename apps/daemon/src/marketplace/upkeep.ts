import { turnOff, type InstallPorts } from "./install.ts";
import { withdrawalOf, type WithdrawnState } from "./listings.ts";
import { newer } from "./prepare.ts";
import type { MarketStore } from "./store.ts";

/*
 * What a refresh does to what is installed, after the listings are read: withdrawn entries are
 * turned off, and each install is marked with the newer version its source offers.
 */

/** Turns off every installed entry a verified list withdrew; a bot stays as Spade made it. */
export async function turnOffWithdrawn(
  ports: () => InstallPorts,
  store: MarketStore,
  state: WithdrawnState,
): Promise<void> {
  for (const install of store.installs()) {
    const reason = withdrawalOf(state, install.source, install);
    // A bot from a version 2 recipe is the person's; a linked one pauses (ADR 0200 §6.1).
    if (!reason || install.state !== "on" || (install.type === "spade-bot" && !install.linked))
      continue;
    const withdrawn = { ...install, state: "withdrawn" as const, reason: reason.slice(0, 500) };
    await turnOff(ports(), withdrawn);
    store.saveInstall(withdrawn);
  }
}

/** Marks each installed entry its source offers a newer version of; never applies one. */
export async function markUpdates(store: MarketStore): Promise<void> {
  const listings = new Map<string, Awaited<ReturnType<MarketStore["listing"]>>>();
  for (const install of store.installs()) {
    // A registry's installs are offered updates from its own list, read as a member.
    if ((install.type === "spade-bot" && !install.linked) || install.bundledBy || install.registry)
      continue;
    const listing = listings.get(install.source) ?? (await store.listing(install.source));
    listings.set(install.source, listing);
    const listed = listing.entries.find(
      (entry) => entry.type === install.type && entry.name === install.name,
    );
    const offered = listed?.version;
    const update = offered && newer(offered, install.version) ? offered : undefined;
    // The index says whether its latest version is deprecated: it speaks for the installed
    // version only when that is the latest.
    const deprecated =
      install.source === "market" && listed?.version === install.version
        ? listed.deprecated?.slice(0, 500)
        : install.deprecated;
    if (update !== install.update || deprecated !== install.deprecated) {
      const { update: _old, deprecated: _note, ...rest } = install;
      store.saveInstall({
        ...rest,
        ...(update ? { update } : {}),
        ...(deprecated ? { deprecated } : {}),
      });
    }
  }
}
