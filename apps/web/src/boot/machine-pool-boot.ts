import type { MachinePool } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import { useEffect, useState } from "react";

/** Kept in step with `directoryKey` in `machine-pool.ts`, which this file must not load. */
const directoryKey = "ace.machines";

function hasDirectory(storage: KeyValueStorage): boolean {
  try {
    return storage.getItem(directoryKey) !== null;
  } catch {
    return false;
  }
}

/**
 * The window's machine pool for one daemon connection: loaded (its own chunk) and started when
 * this browser has a stored machine directory, closed with the connection that made it, so
 * replacing the daemon replaces the pool. Undefined with no directory, or until it loads.
 */
export function useBrowserMachinePool(storage: KeyValueStorage): MachinePool | undefined {
  const [pool, setPool] = useState<MachinePool>();
  useEffect(() => {
    if (!hasDirectory(storage)) return;
    let live = true;
    let made: MachinePool | undefined;
    void import("./machine-pool.ts").then(({ browserMachinePool }) => {
      if (!live) return;
      made = browserMachinePool({ storage });
      // Offline machines never hold up boot; each reports its own status.
      void made.start().catch(() => {});
      setPool(made);
    });
    return () => {
      live = false;
      void made?.close();
      setPool(undefined);
    };
  }, [storage]);
  return pool;
}
