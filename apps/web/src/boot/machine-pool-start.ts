import type { KeyValueStorage } from "@ace/ui-core";
import { accountMachineOptions } from "./account-machine-options.ts";
import { browserMachinePool } from "./machine-pool.ts";

/**
 * The browser's machine pool, started (`machine-pool-boot.ts` loads this on demand, so none of
 * it is in the startup bundle). A pool that fails to start is closed before the error returns.
 */
export async function startBrowserMachinePool(storage: KeyValueStorage, session: KeyValueStorage) {
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
