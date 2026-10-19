import type { KeyValueStorage } from "@ace/ui-core";
import { WorkspaceStore, type PanelPlace } from "@/lib/workspace/index.ts";

/**
 * This device's "Terminals open in" (Settings › General), chosen before the app opens on
 * `storage`, as a person who picked it earlier would have it.
 */
export function terminalsOpenIn(storage: KeyValueStorage, place: PanelPlace): void {
  new WorkspaceStore({ storage }).setPreferredPlace(place);
}
