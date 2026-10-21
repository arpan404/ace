import { compileSchedule } from "@ace/automations/recurrence";
import {
  type AutomationRequest,
  type AutomationResponse,
  type AutomationRun,
  type AutomationTriggerError,
  AutomationPollError,
  AutomationTriggerError as TriggerErrorSchema,
  Automation,
} from "@ace/protocol";

type Result = Omit<AutomationResponse, "type" | "requestId" | "ok"> & { ok?: boolean };
type Schedule = NonNullable<AutomationResponse["schedules"]>[number];
const conflict: Result = { ok: false, error: "Automation revision conflict" };
const missing: Result = { ok: false, error: "Automation is missing" };

/**
 * One store of automations, their revisions, health and runs, as the daemon keeps one for the
 * person and one for agents' thread automations.
 */
export class FakeAutomationStore {
  private now: () => number;
  private enabled: () => boolean;
  private runs = new Map<string, AutomationRun>();
  private automations = new Map<string, Automation>();
  private pollErrors = new Map<string, AutomationPollError>();
  private triggerErrors = new Map<string, AutomationTriggerError>();
  private revisions = new Map<string, number>();
  constructor(now: () => number, enabled: () => boolean) {
    this.now = now;
    this.enabled = enabled;
  }
  seedAutomation(automation: Automation): void {
    this.automations.set(automation.id, Automation.parse(automation));
    if (!this.revisions.has(automation.id)) this.revisions.set(automation.id, 1);
  }
  seedRuns(runs: readonly AutomationRun[]): void {
    for (const run of runs.toSorted((a, b) => a.startedAt - b.startedAt))
      this.runs.set(run.id, run);
  }
  seedPollError(id: string, error: AutomationPollError): void {
    this.pollErrors.set(id, AutomationPollError.parse(error));
  }
  seedTriggerError(id: string, error: AutomationTriggerError): void {
    this.triggerErrors.set(id, TriggerErrorSchema.parse(error));
  }
  seedRevision(id: string, revision: number): void {
    if (Number.isInteger(revision) && revision > 0) this.revisions.set(id, revision);
  }
  has(id: string): boolean {
    return this.automations.has(id);
  }
  put(request: Extract<AutomationRequest, { type: "automation.put" }>): Result {
    const id = request.automation.id;
    const stored = this.revisions.get(id);
    const live = this.automations.has(id);
    if (request.expectedRevision === null && live)
      return { ok: false, error: "Automation already exists" };
    if (typeof request.expectedRevision === "number") {
      if (!live) return missing;
      if (stored !== request.expectedRevision) return conflict;
    }
    if (!live && this.automations.size >= 64) throw new Error("automation_limit");
    this.automations.set(id, request.automation);
    this.revisions.set(id, (stored ?? 0) + 1);
    if (request.automation.trigger.kind !== "github") this.pollErrors.delete(id);
    this.triggerErrors.delete(id);
    return {};
  }
  remove(request: Extract<AutomationRequest, { type: "automation.remove" }>): Result {
    const stored = this.revisions.get(request.id);
    if (typeof request.expectedRevision === "number" && stored !== request.expectedRevision)
      return conflict;
    if (this.automations.has(request.id)) {
      this.automations.delete(request.id);
      this.pollErrors.delete(request.id);
      this.triggerErrors.delete(request.id);
      this.revisions.set(request.id, (stored ?? 0) + 1);
    }
    return {};
  }
  setEnabled(request: Extract<AutomationRequest, { type: "automation.setEnabled" }>): Result {
    const automation = this.automations.get(request.id);
    if (!automation) return missing;
    const stored = this.revisions.get(request.id);
    if (typeof request.expectedRevision === "number" && stored !== request.expectedRevision)
      return conflict;
    this.automations.set(request.id, { ...automation, enabled: request.enabled });
    this.revisions.set(request.id, (stored ?? 0) + 1);
    return {};
  }
  retry(request: Extract<AutomationRequest, { type: "automation.retry" }>): Result {
    const automation = this.automations.get(request.id);
    if (!automation) return missing;
    const stored = this.revisions.get(request.id);
    if (typeof request.expectedRevision === "number" && stored !== request.expectedRevision)
      return conflict;
    if (!automation.enabled) return { ok: false, error: "Automation is disabled or missing" };
    // The fake daemon reinitializes synchronously and clears health on success.
    this.triggerErrors.delete(request.id);
    if (automation.trigger.kind === "github") this.pollErrors.delete(request.id);
    return {};
  }
  list(): { automations: Automation[]; schedules: Schedule[] } {
    const automations = [...this.automations.values()];
    return {
      automations,
      schedules: automations.map((automation) => ({
        id: automation.id,
        revision: this.revisions.get(automation.id) ?? 1,
        lastPollError: this.pollErrors.get(automation.id),
        triggerError:
          this.triggerErrors.get(automation.id) ??
          (automation.trigger.kind === "github" ? this.pollErrors.get(automation.id) : undefined),
        lastRun: [...this.runs.values()]
          .filter((run) => run.automationId === automation.id)
          .toSorted((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
          .at(0),
        nextRunAt:
          this.enabled() && automation.enabled && automation.trigger.kind === "schedule"
            ? (compileSchedule(automation.trigger.schedule).next(this.now() - 1) ?? null)
            : null,
      })),
    };
  }
  inbox(
    request: Extract<AutomationRequest, { type: "automation.inbox" }>,
    shown: (run: AutomationRun) => boolean = () => true,
  ): Result {
    // Sequence cursors mirror the real store, including runs with tied timestamps.
    const rows = [...this.runs.values()]
      .map((run, index) => ({ run, seq: index + 1 }))
      .filter(
        ({ run, seq }) =>
          (request.before === undefined || seq < request.before) &&
          (request.automationId === undefined || run.automationId === request.automationId),
      )
      .toSorted((a, b) => b.seq - a.seq);
    const page = rows.slice(0, request.limit);
    return {
      inbox: {
        runs: page.map(({ run }) => run).filter(shown),
        before: rows.length > request.limit ? (page.at(-1)?.seq ?? null) : null,
      },
    };
  }
  /** A manual run; one request id is one run, however often it is retried. */
  run(request: Extract<AutomationRequest, { type: "automation.run" }>): Result {
    if (!this.enabled()) return { ok: false, error: "Automation service is stopped" };
    const automation = this.automations.get(request.id);
    if (!automation?.enabled) return { ok: false, error: "disabled_or_missing" };
    const id = `run-${request.requestId}`;
    let run = this.runs.get(id);
    if (!run) {
      if (this.runs.size >= 100) this.runs.delete(this.runs.keys().next().value ?? "");
      run = {
        id,
        automationId: automation.id,
        title: automation.title,
        eventKey: `manual:${request.requestId}`,
        trigger: "manual",
        status: "running",
        startedAt: this.now(),
      };
      this.runs.set(id, run);
    }
    return { run };
  }
}
