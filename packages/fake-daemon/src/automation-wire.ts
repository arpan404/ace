import { compileSchedule } from "@ace/automations/recurrence";
import {
  type AutomationRun,
  type AutomationTriggerError,
  AutomationPollError,
  AutomationTriggerError as TriggerErrorSchema,
  ServerMessage,
  Automation,
  type ClientMessage,
  type ServerMessage as Message,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";

export interface AutomationSeed {
  automations?: Automation[];
  runs?: AutomationRun[];
  pollErrors?: Record<string, AutomationPollError>;
  triggerErrors?: Record<string, AutomationTriggerError>;
  revisions?: Record<string, number>;
}
export class FakeAutomationWire {
  private host: FakeServiceContext | undefined;
  private now: () => number;
  private runs = new Map<string, AutomationRun>();
  private automations = new Map<string, Automation>();
  private pollErrors = new Map<string, AutomationPollError>();
  private triggerErrors = new Map<string, AutomationTriggerError>();
  private revisions = new Map<string, number>();
  private enabled: () => boolean;
  constructor(now: () => number, enabled: () => boolean, host?: FakeServiceContext) {
    this.host = host;
    this.now = now;
    this.enabled = enabled;
  }
  /** Seed automations and their past runs, as a daemon that has been running a while. */
  seed(seed: AutomationSeed): void {
    for (const automation of seed.automations ?? []) {
      this.automations.set(automation.id, Automation.parse(automation));
      if (!this.revisions.has(automation.id)) this.revisions.set(automation.id, 1);
    }
    for (const run of (seed.runs ?? []).toSorted((a, b) => a.startedAt - b.startedAt))
      this.runs.set(run.id, run);
    for (const [id, error] of Object.entries(seed.pollErrors ?? {}))
      this.pollErrors.set(id, AutomationPollError.parse(error));
    for (const [id, error] of Object.entries(seed.triggerErrors ?? {}))
      this.triggerErrors.set(id, TriggerErrorSchema.parse(error));
    for (const [id, revision] of Object.entries(seed.revisions ?? {}))
      if (Number.isInteger(revision) && (revision as number) > 0)
        this.revisions.set(id, revision as number);
  }
  handle(message: ClientMessage): Message | undefined {
    if (!("requestId" in message)) return undefined;
    const base = { type: "automation.result", requestId: message.requestId, ok: true };
    switch (message.type) {
      case "automation.put": {
        const id = message.automation.id;
        const stored = this.revisions.get(id);
        const live = this.automations.has(id);
        if (message.expectedRevision === null && live)
          return ServerMessage.parse({ ...base, ok: false, error: "Automation already exists" });
        if (typeof message.expectedRevision === "number") {
          if (!live)
            return ServerMessage.parse({ ...base, ok: false, error: "Automation is missing" });
          if (stored !== message.expectedRevision)
            return ServerMessage.parse({
              ...base,
              ok: false,
              error: "Automation revision conflict",
            });
        }
        if (!live && this.automations.size >= 64) throw new Error("automation_limit");
        this.automations.set(id, message.automation);
        this.revisions.set(id, (stored ?? 0) + 1);
        if (message.automation.trigger.kind !== "github") this.pollErrors.delete(id);
        this.triggerErrors.delete(id);
        return ServerMessage.parse(base);
      }
      case "automation.remove": {
        const stored = this.revisions.get(message.id);
        if (typeof message.expectedRevision === "number" && stored !== message.expectedRevision)
          return ServerMessage.parse({
            ...base,
            ok: false,
            error: "Automation revision conflict",
          });
        if (this.automations.has(message.id)) {
          this.automations.delete(message.id);
          this.pollErrors.delete(message.id);
          this.triggerErrors.delete(message.id);
          this.revisions.set(message.id, (stored ?? 0) + 1);
        }
        return ServerMessage.parse(base);
      }
      case "automation.setEnabled": {
        const automation = this.automations.get(message.id);
        if (!automation)
          return ServerMessage.parse({ ...base, ok: false, error: "Automation is missing" });
        const stored = this.revisions.get(message.id);
        if (typeof message.expectedRevision === "number" && stored !== message.expectedRevision)
          return ServerMessage.parse({
            ...base,
            ok: false,
            error: "Automation revision conflict",
          });
        this.automations.set(message.id, { ...automation, enabled: message.enabled });
        this.revisions.set(message.id, (stored ?? 0) + 1);
        return ServerMessage.parse(base);
      }
      case "automation.retry": {
        const automation = this.automations.get(message.id);
        if (!automation)
          return ServerMessage.parse({ ...base, ok: false, error: "Automation is missing" });
        const stored = this.revisions.get(message.id);
        if (typeof message.expectedRevision === "number" && stored !== message.expectedRevision)
          return ServerMessage.parse({
            ...base,
            ok: false,
            error: "Automation revision conflict",
          });
        if (!automation.enabled)
          return ServerMessage.parse({
            ...base,
            ok: false,
            error: "Automation is disabled or missing",
          });
        // The fake daemon reinitializes synchronously and clears health on success.
        this.triggerErrors.delete(message.id);
        if (automation.trigger.kind === "github") this.pollErrors.delete(message.id);
        return ServerMessage.parse(base);
      }
      case "automation.list":
        return ServerMessage.parse({
          ...base,
          automations: [...this.automations.values()],
          schedules: [...this.automations.values()].map((automation) => ({
            id: automation.id,
            revision: this.revisions.get(automation.id) ?? 1,
            lastPollError: this.pollErrors.get(automation.id),
            triggerError:
              this.triggerErrors.get(automation.id) ??
              (automation.trigger.kind === "github"
                ? this.pollErrors.get(automation.id)
                : undefined),
            lastRun: [...this.runs.values()]
              .filter((run) => run.automationId === automation.id)
              .toSorted((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
              .at(0),
            nextRunAt:
              this.enabled() && automation.enabled && automation.trigger.kind === "schedule"
                ? (compileSchedule(automation.trigger.schedule).next(this.now() - 1) ?? null)
                : null,
          })),
        });
      case "automation.inbox": {
        // Sequence cursors mirror the real store, including runs with tied timestamps.
        const rows = [...this.runs.values()]
          .map((run, index) => ({ run, seq: index + 1 }))
          .filter(
            ({ run, seq }) =>
              (message.before === undefined || seq < message.before) &&
              (message.automationId === undefined || run.automationId === message.automationId),
          )
          .toSorted((a, b) => b.seq - a.seq);
        const page = rows.slice(0, message.limit);
        return ServerMessage.parse({
          ...base,
          inbox: {
            runs: page.map(({ run }) => run),
            before: rows.length > message.limit ? page.at(-1)?.seq : null,
          },
        });
      }
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
