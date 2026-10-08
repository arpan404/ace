import { compileSchedule } from "@ace/automations/recurrence";
import {
  type AutomationRun,
  ServerMessage,
  Automation,
  type ClientMessage,
  type ServerMessage as Message,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";

export interface AutomationSeed {
  automations?: Automation[];
  runs?: AutomationRun[];
}
export class FakeAutomationWire {
  private host: FakeServiceContext | undefined;
  private now: () => number;
  private runs = new Map<string, AutomationRun>();
  private automations = new Map<string, Automation>();
  private enabled: () => boolean;
  constructor(now: () => number, enabled: () => boolean, host?: FakeServiceContext) {
    this.host = host;
    this.now = now;
    this.enabled = enabled;
  }
  /** Seed automations and their past runs, as a daemon that has been running a while. */
  seed(seed: AutomationSeed): void {
    for (const automation of seed.automations ?? [])
      this.automations.set(automation.id, Automation.parse(automation));
    for (const run of seed.runs ?? []) this.runs.set(run.id, run);
  }
  handle(message: ClientMessage): Message | undefined {
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
