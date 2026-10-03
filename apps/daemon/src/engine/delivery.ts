import type { PrepareInput } from "./input.ts";
import { Command } from "@ace/protocol";
import type { ThreadActor } from "./actor.ts";
import type { EngineRepository, Intent } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { Sessions } from "./sessions.ts";

export class DeliveryDeferred extends Error {}

export async function executeIntent(
  actor: ThreadActor,
  intent: Intent,
  repo: EngineRepository,
  registry: AdapterRegistry,
  sessions: Sessions,
  prepare?: PrepareInput,
): Promise<void> {
  const p = intent.command.payload;
  if (p.type === "thread.create" || p.type === "thread.send") {
    await sessions.open(actor);
    const capabilities = registry.get(repo.requireState(actor.id).config.provider).capabilities;
    const session = actor.session;
    if (!session) throw new Error("Provider session exited before send");
    const state = repo.requireState(actor.id);
    const generation = actor.generation;
    const prepared = p.context
      ? await prepare?.(
          p.type === "thread.create"
            ? Command.parse({
                ...intent.command,
                payload: {
                  type: "thread.send",
                  threadId: actor.id,
                  input: p.input,
                  context: p.context,
                  delivery: "queue",
                },
              })
            : intent.command,
          state.config.provider,
          capabilities,
        )
      : undefined;
    if (
      generation !== actor.generation ||
      actor.session !== session ||
      repo.queue.get(actor.id).paused
    ) {
      prepared?.release();
      throw new DeliveryDeferred("Delivery was superseded before provider consumption");
    }
    if (prepared)
      actor.retainInput(
        intent.id,
        prepared.release,
        p.type === "thread.send" && p.delivery === "steer"
          ? state.agents[state.rootKey ?? ""]?.activeRun
          : undefined,
      );
    try {
      await session.send(
        prepared?.input ?? p.input,
        p.type === "thread.send" && p.delivery === "steer" && capabilities.steer
          ? "steer"
          : "queue",
      );
    } catch (error) {
      actor.releaseInput(intent.id);
      throw error;
    }
    return;
  }
  if (!actor.session) throw new Error("Provider session is not live");
  const state = repo.requireState(actor.id);
  if (p.type === "thread.interrupt") {
    const agent = p.agentId === undefined ? undefined : state.indexes.agentKeysById[p.agentId];
    const { capabilities } = registry.get(state.config.provider);
    if (p.cascade && !capabilities.interruptCascades) {
      const target = p.agentId ?? state.agents[state.rootKey ?? ""]?.agent.id;
      const descendants = (id: string): string[] =>
        Object.keys(state.indexes.childrenByParent[id] ?? {}).flatMap((key) =>
          descendants(state.agents[key]?.agent.id ?? "").concat(key),
        );
      for (const key of target ? descendants(target) : [])
        await actor.session.interrupt({ agent: key, cascade: false });
    }
    await actor.session.interrupt({
      ...(agent === undefined ? {} : { agent }),
      cascade: p.cascade,
    });
  } else if (p.type === "interaction.resolve") {
    const entry = Object.entries(state.interactions).find(
      ([, item]) => item.id === p.interactionId,
    );
    if (!entry || entry[1].state !== "pending") throw new Error("Interaction is no longer pending");
    await actor.session.resolve(entry[0], p.resolution);
    await actor.flush();
    if (repo.requireState(actor.id).interactions[entry[0]]?.id !== p.interactionId) return;
    actor.apply([
      {
        type: "interaction.closed",
        interaction: entry[0],
        state: "resolved",
        resolution: p.resolution,
        resolvedBy: intent.command.deviceId,
      },
    ]);
  } else if (p.type === "background_task.stop") {
    const entry = Object.entries(state.tasks).find(([, task]) => task.id === p.taskId);
    if (!entry || entry[1].status !== "running") throw new Error("Task is no longer running");
    await actor.session.stopTask(entry[0]);
  }
}
