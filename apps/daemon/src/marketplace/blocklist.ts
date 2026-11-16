import type { MarketBlocklist, MarketScanFinding } from "@ace/protocol/marketplace";
import { knownBad } from "@ace/marketplace/scan";
import { turnOff, type InstallPorts } from "./install.ts";
import type { StoredInstall } from "./store.ts";

/*
 * Installed entries against the signed blocklist (ADR 0173 §8). When a newer blocklist arrives,
 * the pinned bytes of every install are checked again; a match is turned off as `blocked`, with
 * the reason. Nothing is deleted, and nothing blocked runs or is offered to Spade or plugins.
 */

/** What the blocklist finds in an install's pinned bytes; nothing when they can't be read. */
export async function blockedFindings(
  ports: Pick<InstallPorts, "store">,
  install: StoredInstall,
  blocklist: MarketBlocklist | undefined,
): Promise<MarketScanFinding[]> {
  if (!blocklist) return [];
  const files = await ports.store.pinned(install.hash, install.type).catch(() => undefined);
  return files ? knownBad(files, install.hash, blocklist) : [];
}

/** Turns off every install the blocklist matches; answers whether any changed. */
export async function applyBlocklist(
  ports: InstallPorts,
  blocklist: MarketBlocklist | undefined,
): Promise<boolean> {
  let changed = false;
  for (const install of ports.store.installs()) {
    if (install.state === "blocked") continue;
    const found = await blockedFindings(ports, install, blocklist);
    const first = found[0];
    if (!first) continue;
    if (install.state === "on") await turnOff(ports, install);
    ports.store.saveInstall({
      ...install,
      state: "blocked",
      reason: `Blocked by ace's market: ${first.message}`.slice(0, 500),
    });
    changed = true;
  }
  return changed;
}
