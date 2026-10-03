// TODO(client-gaps): feat/client-protocol-gaps. What a real daemon can't do for a thread yet:
// rename, fork, settle, snooze, delete and unqueue (thread organization commands). Every call
// rejects, so actions report that the daemon can't do them, instead of pretending.
import { UnavailableError } from "@/boot/fake-backend.ts";
import type { ThreadActionsSource } from "./thread-actions-source.ts";

const no = (feature: string) => () => Promise.reject(new UnavailableError(feature));

export function unavailableThreadActions(): ThreadActionsSource {
  return {
    rename: no("Renaming threads"),
    fork: no("Forking threads"),
    settle: no("Settling threads"),
    snooze: no("Snoozing threads"),
    remove: no("Deleting threads"),
    restore: no("Restoring threads"),
    unqueue: no("Withdrawing a queued message"),
    title: () => undefined,
    subscribe: () => () => {},
  };
}
