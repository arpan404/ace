import type { MarketBlocklist, MarketScanFinding } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "@ace/marketplace";
import { knownBad } from "@ace/marketplace/scan";
import { turnOff, type InstallPorts } from "./install.ts";
import type { StoredInstall } from "./store.ts";

/*
 * Installed entries against the signed blocklist (ADR 0174 §8). At startup and on every refresh
 * the pinned bytes of every install not yet blocked are checked against the stored list, so a
 * failure or crash part way is put right the next time; a match is turned off as `blocked`, with
 * the reason. An install checks the bytes it is about to land the same way. Nothing is deleted,
 * and nothing blocked runs or is offered to Spade or plugins.
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

/** Why the blocklist refuses the first of `entries` it matches, if it matches any. */
export function blockedEntry(
  entries: readonly {
    type: string;
    name: string;
    version: string;
    hash: string;
    checked: { files: readonly ArchiveFile[] };
  }[],
  blocklist: MarketBlocklist | undefined,
): string | undefined {
  if (!blocklist) return undefined;
  for (const entry of entries) {
    const first = knownBad(entry.checked.files, entry.hash, blocklist)[0];
    if (first) return `${entry.type}/${entry.name} ${entry.version}: ${first.message}`;
  }
  return undefined;
}

/**
 * Turns off every install the blocklist matches; answers whether any changed. One that can't be
 * turned off now stays as it was, for the next pass, and the rest are still checked.
 */
export async function applyBlocklist(
  ports: InstallPorts,
  blocklist: MarketBlocklist | undefined,
): Promise<boolean> {
  if (!blocklist) return false;
  let changed = false;
  for (const install of ports.store.installs()) {
    if (install.state === "blocked") continue;
    const found = await blockedFindings(ports, install, blocklist);
    const first = found[0];
    if (!first) continue;
    try {
      if (install.state === "on") await turnOff(ports, install);
    } catch {
      continue;
    }
    ports.store.saveInstall({
      ...install,
      state: "blocked",
      reason: `Blocked by ace's market: ${first.message}`.slice(0, 500),
    });
    changed = true;
  }
  return changed;
}
