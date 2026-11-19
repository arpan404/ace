import { DelegationFailure, MachineStatusResult, type MachineThreadView } from "@ace/protocol";

/**
 * Another machine's status answer. A failure reason it words in a way this build can't read
 * (a newer or older peer) is dropped from that one child; its state and result text still
 * arrive, and the rest of the batch is never lost with it.
 */
export function machineStatusThreads(answer: unknown): MachineThreadView[] {
  const parsed = MachineStatusResult.safeParse(answer);
  if (parsed.success) return parsed.data.threads;
  return MachineStatusResult.parse(withoutUnreadableFailures(answer)).threads;
}

function withoutUnreadableFailures(answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null || !("threads" in answer)) return answer;
  const { threads } = answer;
  if (!Array.isArray(threads)) return answer;
  return {
    ...answer,
    threads: threads.map((thread: unknown) => {
      if (typeof thread !== "object" || thread === null || !("failure" in thread)) return thread;
      if (DelegationFailure.safeParse(thread.failure).success) return thread;
      const { failure: _dropped, ...rest } = thread;
      return rest;
    }),
  };
}
