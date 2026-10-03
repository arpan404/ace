import { compileSchedule } from "@ace/automations/recurrence";
import {
  type AutomationRun,
  ServerMessage,
  ConductorRunView,
  Automation,
  type ClientMessage,
  type ServerMessage as Message,
  type ConductorCommandPayload,
} from "@ace/protocol";
import type { FakeConductor } from "./conductor/fake-conductor.ts";
export class FakePlanningWire {
  private conductor: FakeConductor;
  private now: () => number;
  private runs = new Map<string, AutomationRun>();
  private automations = new Map<string, Automation>();
  private enabled: () => boolean;
  constructor(conductor: FakeConductor, now: () => number, enabled: () => boolean) {
    this.conductor = conductor;
    this.now = now;
    this.enabled = enabled;
  }
  command(payload: ConductorCommandPayload) {
    return this.conductor.command(payload);
  }
  private view(id: string) {
    const run = this.conductor.runs().find((entry) => entry.id === id);
    if (!run) return undefined;
    return ConductorRunView.parse({
      id,
      workspaceId: run.workspaceId,
      goal: run.goal,
      phase:
        run.phase === "merged"
          ? "done"
          : run.phase === "paused" || run.phase === "cancelled" || run.phase === "planning"
            ? run.phase
            : "running",
      spent: 0,
      budget: 0,
      plan: run.cards.some((card) => card.kind === "work")
        ? {
            summary: run.goal,
            workstreams: run.cards
              .filter((card) => card.kind === "work")
              .map((card) => ({
                id: card.id,
                title: card.title,
                dependencies: card.dependencies.filter((dependency) =>
                  run.cards.some((other) => other.id === dependency && other.kind === "work"),
                ),
                priority: 0,
                brief: {
                  objective: card.title,
                  instructions: card.note || card.title,
                  acceptance: [card.title],
                  files: [],
                  packages: [],
                  risks: [],
                },
              })),
          }
        : null,
      planApproved: run.planApproved,
      needsUser: run.gate
        ? [
            {
              id: run.gate.id,
              kind: run.gate.kind,
              workstream: null,
              lane: null,
              generation: null,
              message: run.gate.body.slice(0, 2048),
            },
          ]
        : [],
      lanes: [],
      dag: run.cards.map((card) => ({
        id: card.id,
        title: card.title,
        dependencies: card.dependencies,
        state: card.state,
      })),
      truncated: false,
    });
  }
  handle(
    message: ClientMessage,
    send: (message: Message) => void,
    subscriptions: Map<string, () => void>,
  ): Message | undefined {
    if (message.type === "conductor.request") {
      const op = message.operation;
      const base = { type: "conductor.result", requestId: message.requestId, ok: true };
      if (op.op === "list")
        return ServerMessage.parse({
          ...base,
          runs: this.conductor
            .runs()
            .filter((run) => run.id > (op.after ?? ""))
            .slice(0, op.limit)
            .map((run) => this.view(run.id)),
        });
      if (op.op === "unsubscribe") {
        subscriptions.get(op.subscriptionId)?.();
        subscriptions.delete(op.subscriptionId);
        return ServerMessage.parse(base);
      }
      const run = this.view(op.runId);
      if (!run) return ServerMessage.parse({ ...base, ok: false, error: "not_found" });
      if (op.op === "subscribe") {
        if (subscriptions.size >= 8) throw new Error("subscription_limit");
        subscriptions.get(op.subscriptionId)?.();
        subscriptions.set(
          op.subscriptionId,
          this.conductor.subscribe(() => {
            const view = this.view(op.runId);
            if (view)
              send({ type: "conductor.changed", subscriptionId: op.subscriptionId, run: view });
          }),
        );
      }
      return ServerMessage.parse({ ...base, run });
    }
    if (!("requestId" in message)) return undefined;
    const base = { type: "automation.result", requestId: message.requestId, ok: true };
    switch (message.type) {
      case "automation.put":
        if (!this.automations.has(message.automation.id) && this.automations.size >= 64)
          throw new Error("automation_limit");
        this.automations.set(message.automation.id, message.automation);
        return ServerMessage.parse(base);
      case "automation.remove":
        this.automations.delete(message.id);
        return ServerMessage.parse(base);
      case "automation.list":
        return ServerMessage.parse({
          ...base,
          automations: [...this.automations.values()],
          schedules: [...this.automations.values()].map((automation) => ({
            id: automation.id,
            nextRunAt:
              this.enabled() && automation.enabled && automation.trigger.kind === "schedule"
                ? (compileSchedule(automation.trigger.schedule).next(this.now() - 1) ?? null)
                : null,
          })),
        });
      case "automation.inbox":
        return ServerMessage.parse({
          ...base,
          inbox: {
            runs: [...this.runs.values()]
              .filter((run) => !message.before || run.startedAt < message.before)
              .toSorted((a, b) => b.startedAt - a.startedAt)
              .slice(0, message.limit),
            before: null,
          },
        });
      case "automation.run": {
        if (!this.enabled())
          return ServerMessage.parse({
            ...base,
            ok: false,
            error: "Automation service is stopped",
          });
        const automation = this.automations.get(message.id);
        if (!automation?.enabled)
          return ServerMessage.parse({ ...base, ok: false, error: "disabled_or_missing" });
        const id = `run-${message.requestId}`;
        let run = this.runs.get(id);
        if (!run) {
          if (this.runs.size >= 100) this.runs.delete(this.runs.keys().next().value ?? "");
          run = {
            id,
            automationId: automation.id,
            title: automation.title,
            eventKey: `manual:${message.requestId}`,
            trigger: "manual",
            status: "running",
            startedAt: this.now(),
          };
          this.runs.set(id, run);
        }
        return ServerMessage.parse({ ...base, run });
      }
    }
    return undefined;
  }
}
