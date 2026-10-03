import { join } from "node:path";
import { ConductorStore } from "@ace/conductor";
import { ConductorCommandPayload } from "@ace/protocol";
import { NativeConductorExecutor } from "../conductor/executor.ts";
import { DeckObserver } from "../conductor/observer.ts";
import { ConductorRuntime } from "../conductor-runtime.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function startConductor(context: ServiceContext): void {
  const { config, store, resources, services, options, now, id, onListen } = context;
  const delegations = services.agentControl?.delegations;
  if (!services.engine || !delegations) throw new Error("conductor_dependencies_unavailable");
  const native = options.conductor?.execute
    ? undefined
    : new NativeConductorExecutor(context, delegations);
  let observer: DeckObserver | undefined;
  const runtime = new ConductorRuntime(
    new ConductorStore(join(config.dataDir, "conductor.sqlite")),
    store,
    { now, id, agentId: id },
    {
      ...options.conductor,
      autostart: false,
      ...(native
        ? {
            execute: (effect, state) => native.execute(effect, state),
            accounts: (spec, run) => native.accounts(spec, run),
            decorate: (view) => native.decorate(view),
            changed: (run) => observer?.changed(run),
          }
        : {}),
    },
  );
  services.conductor = runtime;
  if (native)
    services.engine.bindHostInteractions((command) => {
      const payload = command.payload;
      if (payload.type !== "interaction.resolve") return undefined;
      const owner = native.journal.gate(payload.interactionId);
      if (!owner) return undefined;
      const state = runtime.state(owner.run);
      if (!state?.gates[owner.gate])
        return { commandId: command.id, ok: false, error: "already_resolved" };
      if (payload.resolution.kind !== "plan_review")
        return { commandId: command.id, ok: false, error: "invalid_resolution" };
      try {
        runtime.approveInteraction(owner.run, `host.${command.id}`, {
          gateId: owner.gate,
          decision: payload.resolution.decision === "approve" ? "approve" : "reject",
        });
        return { commandId: command.id, ok: true };
      } catch {
        return { commandId: command.id, ok: false, error: "conductor_approval_required" };
      }
    });
  if (native) observer = new DeckObserver(context, runtime, native);
  onListen.push(async () => {
    if (observer) await observer.start();
    else runtime.start();
  });
  resources.onShutdown(() => observer?.stopAdmission());
  resources.own(async () => {
    await observer?.close();
    await runtime.close();
    await native?.worktrees.close();
  });
}
export function createConductorSession({
  options,
  authorize,
  send,
  connected,
}: SocketContext): SocketService {
  const subscriptions = new Map<string, () => void>();
  return {
    close() {
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
    },
    command: {
      types: ConductorCommandPayload.options.map((schema) => schema.shape.type.value),
      scope: () => "operate",
      accept(command) {
        send({
          type: "commandResult",
          ...(options.conductor?.command(command) ?? {
            commandId: command.id,
            ok: false,
            error: "conductor_unavailable",
          }),
        });
      },
    },
    handle(message) {
      if (message.type !== "conductor.request") return false;
      const runtime = options.conductor;
      const reply = (error: string) =>
        send({ type: "conductor.result", requestId: message.requestId, ok: false, error });
      if (!authorize("read") || !runtime) {
        reply(authorize("read") ? "conductor_unavailable" : "forbidden");
        return true;
      }
      const op = message.operation;
      try {
        if (op.op === "unsubscribe") {
          subscriptions.get(op.subscriptionId)?.();
          subscriptions.delete(op.subscriptionId);
          send({ type: "conductor.result", requestId: message.requestId, ok: true });
          return true;
        }
        if (op.op === "list") {
          send({
            type: "conductor.result",
            requestId: message.requestId,
            ok: true,
            ...runtime.list(op.after, op.limit),
          });
          return true;
        }
        const run = runtime.get(op.runId);
        if (!run) {
          reply("not_found");
          return true;
        }
        if (op.op === "subscribe") {
          if (subscriptions.size >= 8 || subscriptions.has(op.subscriptionId)) {
            reply("subscription_limit");
            return true;
          }
          subscriptions.set(
            op.subscriptionId,
            runtime.subscribe(op.runId, (view) => {
              if (connected() && authorize("read"))
                send({ type: "conductor.changed", subscriptionId: op.subscriptionId, run: view });
            }),
          );
        }
        send({ type: "conductor.result", requestId: message.requestId, ok: true, run });
      } catch {
        reply("conductor_read_failed");
      }
      return true;
    },
  };
}
