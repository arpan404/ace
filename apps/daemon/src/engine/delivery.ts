import type { PrepareInput } from "./input.ts";
import type { ThreadTransitions } from "./transitions.ts";
import { Command, ContextDiagnostic } from "@ace/protocol";
import type { ThreadActor } from "./actor.ts";
import type { EngineRepository, Intent } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { Sessions } from "./sessions.ts";

export class DeliveryDeferred extends Error {}
export class DeliveryNotStarted extends Error {}

export async function executeIntent(
  actor: ThreadActor,
  intent: Intent,
  repo: EngineRepository,
  registry: AdapterRegistry,
  sessions: Sessions,
  transitions: ThreadTransitions,
  prepare?: PrepareInput,
  beforeSend?: (
    threadId: import("@ace/protocol").ThreadId,
    commandId: import("@ace/protocol").CommandId,
  ) => Promise<void>,
): Promise<void> {
  const p = intent.command.payload;
  if (p.type === "thread.create" || p.type === "thread.send" || p.type === "thread.fork") {
    if (repo.store.getThread(actor.id)?.deletedAt !== undefined) throw new Error("Thread deleted");
    if (p.type === "thread.fork") await transitions.freezeForkSource(p.threadId, actor.id);
    if (p.type === "thread.send") await transitions.selectNext(actor, intent, p.model, p.options);
    if ("context" in p && p.context && !prepare)
      throw new Error("Context preparation is unavailable");
    try {
      await sessions.open(actor);
    } catch (error) {
      throw new DeliveryNotStarted(error instanceof Error ? error.message : String(error));
    }
    await repo.store.writable();
    if (repo.cancelled(intent.id)) throw new Error("Cancelled before delivery");
    const capabilities =
      actor.effectiveCapabilities ??
      registry.get(repo.requireState(actor.id).config.provider, repo.backend(actor.id))
        .capabilities;
    const session = actor.session;
    if (!session) throw new Error("Provider session exited before send");
    const state = repo.requireState(actor.id);
    const generation = actor.generation;
    const prepared =
      "context" in p && p.context
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
    await repo.store.writable();
    if (
      repo.cancelled(intent.id) ||
      actor.lifetime?.signal.aborted ||
      generation !== actor.generation ||
      actor.session !== session ||
      repo.queue.get(actor.id).paused
    ) {
      prepared?.release();
      throw new DeliveryDeferred("Delivery was superseded before provider consumption");
    }
    // Commit before any send/admission frame; resume can resolve echoes even if no item survived.
    if (prepared?.attachments) repo.attachments.remember(actor.id, intent.id, prepared.attachments);
    if (prepared)
      actor.retainInput(
        intent.id,
        prepared.release,
        p.type === "thread.send" && p.delivery === "steer"
          ? state.agents[state.rootKey ?? ""]?.activeRun
          : undefined,
      );
    try {
      if (!state.agents[state.rootKey ?? ""]?.activeRun) {
        try {
          await beforeSend?.(actor.id, intent.command.id);
        } catch (error) {
          throw new DeliveryNotStarted(error instanceof Error ? error.message : String(error));
        }
      }
      await repo.store.writable();
      if (
        repo.cancelled(intent.id) ||
        actor.lifetime?.signal.aborted ||
        generation !== actor.generation ||
        actor.session !== session ||
        repo.queue.get(actor.id).paused
      )
        throw new DeliveryDeferred("Delivery was superseded during checkpoint preparation");
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
      if (repo.cancelled(intent.id)) throw new Error("Cancelled before delivery");
      actor.lifetime?.signal.throwIfAborted();
      await session.send(
        [
          ...transitions.input(actor.id).map((text) => ({ type: "text" as const, text })),
          ...(prepared?.input ??
            (p.type === "thread.fork" ? [{ type: "text" as const, text: p.input }] : p.input)),
        ],
        p.type === "thread.send" && p.delivery === "steer" && capabilities.steer
          ? "steer"
          : "queue",
        intent.command.id,
        repo.aceInputs.get(actor.id, intent.command.id) ? "ace" : undefined,
      );
      await repo.store.writable();
      transitions.delivered(actor.id);
    } catch (error) {
      actor.releaseInput(intent.id);
      throw error;
    }

    return;
  }
  if (!actor.session) {
    if (
      p.type === "thread.interrupt" &&
      (actor.lifetime ? !actor.lifetime.signal.aborted : !repo.requireState(actor.id).hasRun)
    ) {
      if (actor.lifetime) actor.lifetime.abort();
      else actor.apply([{ type: "process.exited", deliberate: true }]);
      return;
    }
    throw new Error("Provider session is not live");
  }
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
      actor.effectiveCapabilities ??
      registry.get(state.config.provider, repo.backend(actor.id)).capabilities;
    if (p.cascade && !capabilities.interruptCascades) {
      const target = p.agentId ?? state.agents[state.rootKey ?? ""]?.agent.id;
      const descendants = (id: string): string[] =>
        Object.keys(state.indexes.childrenByParent[id] ?? {})
          .filter((key) => !state.agents[key]?.externalStatus)
          .flatMap((key) => descendants(state.agents[key]?.agent.id ?? "").concat(key));
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
    try {
      await actor.session.resolve(entry[0], p.resolution);
    } catch (error) {
      await actor.flush();
      const current = repo.requireState(actor.id);
      const interaction = current.interactions[entry[0]];
      const owner = interaction ? current.indexes.agentKeysById[interaction.agentId] : undefined;
      if (
        interaction?.id === p.interactionId &&
        interaction.state === "pending" &&
        owner &&
        !current.agents[owner]?.activeRun
      )
        actor.apply([{ type: "interaction.closed", interaction: entry[0], state: "cancelled" }]);
      throw error;
    }
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
