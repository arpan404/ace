import {
  Automation,
  AutomationEvent,
  AutomationRequest,
  type AutomationResponse,
  type AutomationRun,
} from "@ace/protocol";
import { type Dependencies, type ExecutionInput } from "./contracts.ts";
import { renderPrompt, scheduledDeadline, recoverOccurrence } from "./decisions.ts";
import { Occurrence } from "./recurrence.ts";
import { AutomationStore, type JobMetadata } from "./store.ts";
import { pollGithub } from "./github.ts";
import { ExecutionOwner } from "./execution-owner.ts";
import { observe } from "./observation.ts";
import { AutomationRuntime } from "./runtime.ts";
import type { GhClient } from "./gh-process.ts";

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8192);
}
export class AutomationService {
  private store: AutomationStore;
  private deps: Dependencies;
  private gh: GhClient | undefined;
  private runtime: AutomationRuntime;
  private executions: ExecutionOwner;
  private cancelTimer: (() => void) | undefined;
  private pending = new Set<Promise<void>>();
  private polling = new Set<string>();
  private live = false;
  private controller = new AbortController();
  private generation = 0;
  private ticking = false;
  constructor(store: AutomationStore, deps: Dependencies, gh?: GhClient) {
    this.store = store;
    this.deps = deps;
    this.gh = gh;
    this.executions = new ExecutionOwner(
      store,
      deps,
      (run) => this.publish(run),
      (error) => this.report(error),
    );
    this.runtime = new AutomationRuntime(
      deps,
      () => this.live,
      (id, event) => {
        this.trigger(id, event, "file");
      },
      (error) => this.report(error),
    );
  }
  start(): void {
    if (this.live) return;
    this.live = true;
    this.generation++;
    this.controller = new AbortController();
    try {
      for (const job of this.store.jobs()) {
        this.runtime.install(this.runtime.prepare(job.automation));
        if (
          job.automation.trigger.kind === "schedule" &&
          job.nominal !== null &&
          job.due !== null
        ) {
          const recurrence = this.runtime.recurrence(job.automation.id);
          if (!recurrence) throw new Error("Missing recurrence");
          const cursor = Occurrence.parse(this.store.readState(job.automation.id));
          const occurrence = recoverOccurrence(
            job.automation,
            recurrence,
            cursor,
            job.due,
            this.deps.now(),
          );
          if (occurrence?.at !== job.nominal)
            this.store.transaction(() => {
              this.store.advance(
                job.automation.id,
                occurrence?.at,
                scheduledDeadline(
                  occurrence,
                  recurrence,
                  job.automation.jitterMs,
                  this.deps.random(),
                ),
              );
              this.store.savePoll(job.automation.id, occurrence ?? {});
            });
        }
      }
      for (const { run, input } of this.store.active()) this.executions.restore(run, input);
      this.arm();
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  stop(): void {
    this.live = false;
    this.generation++;
    this.controller.abort();
    this.executions.stop();
    this.pending.clear();
    this.polling.clear();
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.runtime.stop();
  }
  /** Tests and orderly shutdown can await already admitted work, without polling. */
  async settled(): Promise<void> {
    while (this.pending.size || this.executions.hasWork)
      await Promise.all([...this.pending, this.executions.settled()]);
  }
  private report(error: unknown): void {
    try {
      this.deps.onError(error);
    } catch {
      /* Error reporting cannot break durable scheduling. */
    }
  }
  private publish(run: AutomationRun): void {
    try {
      this.deps.onRun?.(run);
    } catch (error) {
      this.report(error);
    }
  }
  put(input: unknown): Automation {
    const automation = Automation.parse(input);
    const existing = this.store.definition(automation.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(automation)) {
      if (this.runtime.needsWatch(automation))
        this.runtime.install(this.runtime.prepare(automation));
      return automation;
    }
    const prepared = this.runtime.prepare(automation);
    const recurrence = prepared.recurrence;
    const occurrence =
      automation.enabled && recurrence ? recurrence.seek(this.deps.now() - 1) : undefined;
    const nominal = occurrence?.at;
    const due = !automation.enabled
      ? undefined
      : automation.trigger.kind === "github"
        ? this.deps.now()
        : recurrence
          ? scheduledDeadline(occurrence, recurrence, automation.jitterMs, this.deps.random())
          : undefined;
    try {
      this.store.put(automation, nominal, due, occurrence ?? {});
    } catch (error) {
      this.runtime.discard(prepared);
      throw error;
    }
    this.runtime.install(prepared);
    this.arm();
    return automation;
  }
  remove(id: string): void {
    this.store.remove(id);
    this.runtime.remove(id);
    this.arm();
  }
  list(): Automation[] {
    return this.store.list().map((job) => job.automation);
  }
  inbox(limit = 50, before?: number) {
    return this.store.inbox(limit, before);
  }
  trigger(id: string, input: unknown, kind: AutomationRun["trigger"] = "manual"): AutomationRun {
    if (!this.live) throw new Error("Automation service is stopped");
    const generation = this.generation;
    const automation = this.store.definition(id);
    if (!automation || !automation.enabled) throw new Error("Automation is disabled or missing");
    const event = AutomationEvent.parse(input);
    const admission = this.store.transaction(() => this.admit(automation, event, kind));
    if (admission.created) this.publish(admission.run);
    if (admission.admitted && admission.input && this.live && generation === this.generation)
      this.executions.launch(admission.run, admission.input);
    return admission.run;
  }
  private admit(automation: Automation, event: AutomationEvent, kind: AutomationRun["trigger"]) {
    const id = this.deps.id();
    let input: ExecutionInput | undefined;
    let failure: string | undefined;
    try {
      input = {
        idempotencyKey: id,
        automationId: automation.id,
        provider: automation.provider,
        workspace: automation.workspace,
        worktree: automation.worktree,
        prompt: renderPrompt(automation.prompt, event.variables),
        ...(automation.model ? { model: automation.model } : {}),
      };
    } catch (error) {
      failure = message(error);
    }
    return {
      ...this.store.claim(automation, event, kind, id, this.deps.now(), input, failure),
      input,
    };
  }
  private track(operation: Promise<void>): void {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }
  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.live || this.ticking) return;
    const job = this.nextJob();
    if (job?.due === null || job?.due === undefined) return;
    const delay = Math.min(2_147_483_647, Math.max(0, job.due - this.deps.now()));
    this.cancelTimer = this.deps.timer.arm(delay, () => {
      this.cancelTimer = undefined;
      const operation = this.tick().catch((error) => this.report(error));
      this.track(operation);
      return operation;
    });
  }
  private nextJob(): JobMetadata | undefined {
    return this.polling.size >= 4 ? this.store.nextScheduled() : this.store.next([...this.polling]);
  }
  private async tick(): Promise<void> {
    this.ticking = true;
    try {
      // A bounded batch yields to I/O if a large number of jobs share a deadline.
      for (let i = 0; i < 100 && this.live; i++) {
        const job = this.nextJob();
        if (!job || job.due === null || job.due > this.deps.now()) break;
        if (job.automation.trigger.kind === "github") {
          const generation = this.generation;
          this.polling.add(job.automation.id);
          this.track(
            this.poll(job).finally(() => {
              if (generation === this.generation) {
                this.polling.delete(job.automation.id);
                this.arm();
              }
            }),
          );
        } else this.scheduled(job);
      }
    } finally {
      this.ticking = false;
      this.arm();
    }
  }
  private scheduled(job: JobMetadata): void {
    const generation = this.generation;
    const recurrence = this.runtime.recurrence(job.automation.id);
    if (!recurrence || job.nominal === null) throw new Error("Invalid scheduled job");
    // Compute before admission so any evaluation error cannot partially advance the cursor.
    let occurrence: Occurrence | undefined;
    try {
      occurrence = recurrence.seek(
        Math.max(job.nominal, this.deps.now()),
        Occurrence.parse(this.store.readState(job.automation.id)),
      );
    } catch (error) {
      this.store.advance(job.automation.id, undefined, undefined);
      throw error;
    }
    const nominal = occurrence?.at;
    const due = scheduledDeadline(
      occurrence,
      recurrence,
      job.automation.jitterMs,
      this.deps.random(),
    );
    const admission = this.store.transaction(() => {
      const result = this.admit(
        job.automation,
        {
          key: `schedule:${job.nominal}`,
          variables: { scheduled_at: new Date(job.nominal ?? 0).toISOString() },
        },
        "schedule",
      );
      this.store.advance(job.automation.id, nominal, due);
      this.store.savePoll(job.automation.id, occurrence ?? {});
      return result;
    });
    if (admission.created) this.publish(admission.run);
    if (admission.admitted && admission.input && this.live && generation === this.generation)
      this.executions.launch(admission.run, admission.input);
  }
  private async poll(job: JobMetadata): Promise<void> {
    const generation = this.generation;
    const revision = this.runtime.current(job.automation.id);
    const trigger = job.automation.trigger;
    if (trigger.kind !== "github") return;
    // Advance before I/O to bound repeated failures and prevent a busy loop.
    this.store.advance(job.automation.id, undefined, this.deps.now() + trigger.pollIntervalMs);
    try {
      if (!this.gh) throw new Error("GitHub client is not configured");
      const result = await observe(
        pollGithub(
          this.gh,
          trigger,
          this.store.readState(job.automation.id),
          this.controller.signal,
        ),
        this.controller.signal,
      );
      if (result === undefined) return;
      if (!this.live || generation !== this.generation) return;
      // An edit/removal while gh was in flight invalidates this response.
      if (this.runtime.current(job.automation.id) !== revision) return;
      for (const event of result.events) {
        if (
          !this.live ||
          generation !== this.generation ||
          this.runtime.current(job.automation.id) !== revision
        )
          return;
        this.trigger(job.automation.id, event, "github");
      }
      if (
        result.changed &&
        this.live &&
        generation === this.generation &&
        this.runtime.current(job.automation.id) === revision
      )
        this.store.savePoll(job.automation.id, result.state);
    } catch (error) {
      this.report(error);
    }
  }
  handle(input: unknown): AutomationResponse {
    const request = AutomationRequest.parse(input);
    try {
      const base = { type: "automation.result" as const, requestId: request.requestId, ok: true };
      switch (request.type) {
        case "automation.put":
          this.put(request.automation);
          return base;
        case "automation.remove":
          this.remove(request.id);
          return base;
        case "automation.run":
          return {
            ...base,
            run: this.trigger(request.id, {
              key: `manual:${request.requestId}`,
              variables: request.variables,
            }),
          };
        case "automation.list":
          return { ...base, automations: this.list() };
        case "automation.inbox":
          return { ...base, inbox: this.inbox(request.limit, request.before) };
      }
    } catch (error) {
      return {
        type: "automation.result",
        requestId: request.requestId,
        ok: false,
        error: message(error),
      };
    }
  }
}
