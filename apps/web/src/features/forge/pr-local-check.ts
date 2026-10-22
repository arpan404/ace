import type { ForgePrStatus } from "@ace/protocol";
import { latestLocalCheck, localCheckOf } from "@ace/ui-core";
import { useVerifyRuns } from "@/lib/verify.ts";

/**
 * A PR's latest local check (ADR 0094): the run for its current head, what it says as a
 * check, and the command the project's runs use (null when it has none; undefined while the
 * project's runs are still being read).
 */
export function usePrLocalCheck(
  workspaceId: string,
  status: Pick<ForgePrStatus, "ref" | "headSha">,
) {
  const verify = useVerifyRuns(workspaceId);
  const runs = verify.data?.runs ?? [];
  const pr = {
    owner: status.ref.repository.owner,
    name: status.ref.repository.name,
    number: status.ref.number,
  };
  return {
    run: latestLocalCheck(runs, pr, status.headSha),
    result: localCheckOf(runs, pr, status.headSha),
    command: verify.data?.command,
  };
}
