import type { Effect } from "@ace/conductor";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "../agent-control/delegations.ts";
import type { ExecutionJournal, LaneBinding } from "./journal.ts";
import type { DeckCommands } from "./command-attempts.ts";

export async function controlLane(
  effect: Extract<Effect, { type: "control" }>,
  binding: LaneBinding,
  context: ServiceContext,
  journal: ExecutionJournal,
  delegations: DelegationService,
  commands: DeckCommands,
  effectKey: (...parts: string[]) => string,
) {
  const engine = context.services.engine;
  if (!engine) throw new Error("deck_engine_unavailable");
  if (effect.action === "force_cancel") {
    const root = journal.root(binding.run);
    const threads = root
      ? delegations.journal
          .family(root.thread)
          .filter(
            (edge) =>
              edge.phase !== "settled" &&
              delegations.journal.isDescendant(edge.childId, binding.thread),
          )
          .toSorted((a, b) => b.depth - a.depth)
          .map((edge) => edge.childId)
      : [];
    for (const thread of [...threads, binding.thread])
      await engine.terminateDelegatedThread(thread);
  } else if (effect.action === "cancel") {
    delegations.cancelDescendants(binding.thread, effect.id);
    const result = delegations.command(effect.id, {
      type: "thread.interrupt",
      threadId: binding.thread,
      cascade: true,
    });
    if (!result.ok) {
      const root = journal.root(binding.run);
      const reservation = root && delegations.journal.reservation(root.thread, binding.request);
      if (reservation && !context.store.getThread(binding.thread)) {
        delegations.releaseReservation(reservation);
        return;
      }
      throw new Error(result.error);
    }
  } else if (effect.action === "pause" || effect.action === "resume") {
    const root = journal.root(binding.run);
    const children = root
      ? delegations.journal
          .family(root.thread)
          .filter(
            (edge) =>
              edge.phase !== "settled" &&
              delegations.journal.isDescendant(edge.childId, binding.thread),
          )
          .toSorted((a, b) => b.depth - a.depth)
          .map((edge) => edge.childId)
      : [];
    const threads = [...children, binding.thread];
    for (const threadId of threads) {
      const queue = engine.queuePage({ threadId });
      if (effect.action === "resume" && !queue.paused) continue;
      const key = effectKey(effect.id, threadId, "queue");
      const payload =
        effect.action === "pause"
          ? { type: "queue.pause" as const, threadId, expectedRevision: queue.revision }
          : { type: "thread.resume" as const, threadId, expectedRevision: queue.revision };
      const result = await commands.run(key, payload);
      if (!result.ok) throw new Error(result.error);
      if (effect.action === "pause") {
        const interrupted = delegations.suspend(threadId, effectKey(effect.id, threadId, "pause"));
        if (!interrupted.ok) throw new Error(interrupted.error);
      }
    }
  } else throw new Error("deck_destructive_gate_requires_provider_approval");
}
