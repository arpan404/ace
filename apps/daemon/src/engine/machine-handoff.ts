import { handoffSources, renderHandoff } from "@ace/handoff";
import type { PortableHandoff, ProviderKind, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { handoff } from "./transition-history.ts";

/*
 * A thread's history carried to another machine (ADR 0099). The source captures the same
 * bounded, conversation-first handoff a provider switch builds; the target keeps it waiting on
 * the new thread, so it goes in front of the person's next message there, as a switch's does.
 */

/** About 8k tokens, as a cross-provider switch carries. */
export const machineHandoffBytes = 32768;

export function captureMachineHandoff(
  repo: EngineRepository,
  id: ThreadId,
  provider: ProviderKind,
): PortableHandoff {
  return handoff(repo, id, repo.store.headSeq(), machineHandoffBytes, provider);
}

/**
 * What the new agent is told beyond the excerpts: their source lives on another machine, so
 * `handoff_read` can't page it here, and attachments stayed behind.
 */
export function machineHandoffNote(machine: string): string {
  return (
    `This thread continues one from ${machine}. The handoff above was carried from there: ` +
    `its earlier items, full tool output and attachments stayed on ${machine} and can't be read from this machine.`
  );
}

export function adoptMachineHandoff(
  repo: EngineRepository,
  id: ThreadId,
  input: {
    handoff: PortableHandoff;
    commandId: string;
    machine: string;
    to: { provider: ProviderKind; model?: string | undefined };
    at: number;
  },
): void {
  const { handoff: carried } = input;
  const marker = `handoff:${input.commandId}`;
  const from = carried.origin?.provider ?? input.to.provider;
  repo.store.atomic(() => {
    const previous = repo.transitions.get(id);
    repo.transitions.set(id, {
      ...previous,
      handoff: carried,
      marker,
      context: [...previous.context, machineHandoffNote(input.machine)],
    });
    repo.syntheticInput(
      id,
      marker,
      renderHandoff(carried),
      {
        kind: "handoff",
        from: { provider: from },
        to: { provider: input.to.provider, ...(input.to.model ? { model: input.to.model } : {}) },
        sources: carried.sources ?? handoffSources([], { provider: from }),
        lossy: true,
      },
      input.at,
    );
  });
}
