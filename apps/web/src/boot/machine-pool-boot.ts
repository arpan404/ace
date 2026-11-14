import type { MachinePool } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Startup } from "@/lib/startup/startup.tsx";

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
  const [{ browserMachinePool }, { accountMachineOptions }] = await Promise.all([
    import("./machine-pool.ts"),
    import("./account-machine-options.ts"),
  ]);
  const made = browserMachinePool({
    storage,
    session,
    account: accountMachineOptions({ storage, session }),
  });
  try {
    await made.start();
    return made;
  } catch (error) {
    await made.close();
    throw error;
  }
}

/** When a stored pool starts at boot: calls `start` once, or never if cancelled first. */
export type PoolStart = (start: () => void) => () => void;

/**
 * Start the pool once the first screen is up (the startup screen has left, whether for the app
 * or another screen) and the browser is idle. Each paired machine is a worker with sockets of
 * its own; started at mount they compete with the open thread's code, the client worker and its
 * socket for the same connections.
 */
export function afterFirstScreen(
  startup: Pick<Startup, "getSnapshot" | "subscribe">,
  idle: (run: () => void) => () => void,
): PoolStart {
  const shown = () => {
    const phase = startup.getSnapshot().phase;
    return phase === "leaving" || phase === "gone";
  };
  return (start) => {
    let cancelIdle: (() => void) | undefined;
    const go = () => {
      cancelIdle ??= idle(start);
    };
    if (shown()) {
      go();
      return () => cancelIdle?.();
    }
    const stop = startup.subscribe(() => {
      if (!shown()) return;
      stop();
      go();
    });
    return () => {
      stop();
      cancelIdle?.();
    };
  };
}

const atOnce: PoolStart = (start) => {
  start();
  return () => {};
};

/**
 * Lazy startup keeps the pool out of the initial bundle; Settings can create it on demand
 * (`ensure`) at any time. A stored pool starts by itself when `when` says (at once by default).
 */
export function useBrowserMachinePool(
  storage: KeyValueStorage,
  session: KeyValueStorage,
  when: PoolStart = atOnce,
) {
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
    const cancel = hasDirectory(storage) ? when(() => void ensure().catch(() => {})) : () => {};
    const close = () => {
      cancel();
      live.current = false;
      epoch.current++;
      void pending.current?.then((made) => made.close()).catch(() => {});
      pending.current = undefined;
    };
    return close;
  }, [storage, ensure, when]);
  return { pool, ensure };
}
