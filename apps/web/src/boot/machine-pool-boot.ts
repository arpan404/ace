import type { MachinePool } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import { useCallback, useEffect, useRef, useState } from "react";

/** Kept in step with `directoryKey` in `machine-pool.ts`, which this file must not load. */
const directoryKey = "ace.machines";

function hasDirectory(storage: KeyValueStorage): boolean {
  try {
    return storage.getItem(directoryKey) !== null;
  } catch {
    return false;
  }
}

async function createPool(storage: KeyValueStorage, session: KeyValueStorage) {
  const { browserMachinePool } = await import("./machine-pool.ts");
  const made = browserMachinePool({ storage, session });
  try {
    await made.start();
    return made;
  } catch (error) {
    await made.close();
    throw error;
  }
}

/** Lazy startup keeps the pool out of the initial bundle; Settings can create it on demand. */
export function useBrowserMachinePool(storage: KeyValueStorage, session: KeyValueStorage) {
  const [pool, setPool] = useState<MachinePool>();
  const pending = useRef<Promise<MachinePool> | undefined>(undefined);
  const live = useRef(true);
  const epoch = useRef(0);
  const ensure = useCallback(() => {
    const generation = epoch.current;
    return (pending.current ??= createPool(storage, session)
      .then(async (made) => {
        if (!live.current || generation !== epoch.current) {
          await made.close();
          throw new Error("Connection closed");
        }
        setPool(made);
        return made;
      })
      .catch((error: unknown) => {
        if (generation === epoch.current) pending.current = undefined;
        throw error;
      }));
    // Stable identity prevents state publication from disposing the newly opened pool.
    // oxlint-disable-next-line react/memo-dependencies
  }, [storage, session]);
  useEffect(() => {
    live.current = true;
    if (hasDirectory(storage)) void ensure().catch(() => {});
    const close = () => {
      live.current = false;
      epoch.current++;
      void pending.current?.then((made) => made.close()).catch(() => {});
      pending.current = undefined;
    };
    return close;
  }, [storage, ensure]);
  return { pool, ensure };
}
