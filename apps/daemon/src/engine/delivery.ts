import type { PrepareInput } from "./input.ts";
import { Command, ContextDiagnostic } from "@ace/protocol";
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
    if (p.context && !prepare) throw new Error("Context preparation is unavailable");
    await sessions.open(actor);
    const capabilities =
      actor.effectiveCapabilities ??
      registry.get(repo.requireState(actor.id).config.provider).capabilities;
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
      for (const [index, diagnostic] of (prepared?.diagnostics ?? []).slice(0, 64).entries()) {
        const parsed = ContextDiagnostic.parse(diagnostic);
        actor.apply([
          {
            type: "item.upsert",
            agent: state.rootKey ?? "root",
            item: `intent:${intent.id}:context:${index}`,
            draft: {
              type: "notice",
              level: "warning",
              complete: true,
              text: `Context ${parsed.code}: ${parsed.message.slice(0, 4096)}${parsed.path ? ` (${parsed.path.slice(0, 1024)})` : ""}`,
            },
          },
        ]);
      }
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
  if (p.type === "thread.model.set") {
    if (!actor.session.setModel) throw new Error("Provider model selection unavailable");
    await actor.session.setModel(p.model);
    await actor.flush();
    const confirmed = repo.requireState(actor.id);
    try {
      repo.store.atomic((db) => {
        if (confirmed.rootKey)
          actor.apply([{ type: "agent.linked", agent: confirmed.rootKey, model: p.model }]);
        db.prepare("UPDATE engine_sessions SET model=? WHERE thread_id=?").run(p.model, actor.id);
      });
    } catch (error) {
      // The outer transaction can fail after fact folding mutated the hot state.
      repo.evict(actor.id);
      throw error;
    }
  } else if (p.type === "thread.mode.set") {
    if (!actor.session.setMode) throw new Error("Provider mode selection unavailable");
    await actor.session.setMode(p.mode);
  } else if (p.type === "thread.interrupt") {
    const agent = p.agentId === undefined ? undefined : state.indexes.agentKeysById[p.agentId];
    const capabilities =
      actor.effectiveCapabilities ?? registry.get(state.config.provider).capabilities;
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
