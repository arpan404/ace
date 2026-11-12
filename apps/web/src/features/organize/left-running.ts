import type { ClientApi } from "@ace/client";
import { leftRunningCommands } from "@ace/ui-core";
import type { ThreadTarget } from "./thread-action-types.ts";

/** How many commands each thread left running, as the list has it now. */
export function leftRunningOn(client: ClientApi, entries: readonly ThreadTarget[]) {
  const lease = client.threads();
  const counts = entries.map((entry) => {
    const listed = lease.store.thread(entry.id);
    return { title: entry.title, leftRunning: listed ? leftRunningCommands(listed) : 0 };
  });
  lease.release();
  return counts;
}
