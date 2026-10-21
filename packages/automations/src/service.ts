import { createHash } from "node:crypto";
import {
  type Automation,
  AutomationEvent,
  AutomationRequest,
  type AutomationResponse,
  type AutomationRun,
} from "@ace/protocol";
import { type Dependencies, type ExecutionInput } from "./contracts.ts";
import { renderPrompt, scheduledDeadline, recoverOccurrence, withRunNote } from "./decisions.ts";
import { normalizeAutomation } from "./definition.ts";
import { Occurrence } from "./recurrence.ts";
import { AutomationStore, type JobMetadata } from "./store.ts";
import { pollGithub } from "./github.ts";
import { Lifecycle } from "./lifecycle.ts";
import { ExecutionOwner } from "./execution-owner.ts";
import { observe } from "./observation.ts";
import { AutomationRuntime } from "./runtime.ts";
import type { GhClient } from "./gh-process.ts";

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8192);
}
/**
 * Deterministic manual idempotency keys survive run-history eviction: the same
 * automation id plus event key always maps to the same key, so the executor's
 * command-receipt dedup holds even after the run row is pruned. Length-prefixed
 * scoping keeps automation/event boundaries unambiguous before hashing.
 */
function manualId(automationId: string, eventKey: string): string {
  const scoped = `${automationId.length}:${automationId}:${eventKey}`;
  return `manual-${createHash("sha256").update(scoped).digest("hex")}`;
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
  private lifecycle = new Lifecycle();
  private get live(): boolean {
    return this.lifecycle.live;
  }
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
      () => this.arm(),
    );
    this.runtime = new AutomationRuntime(
      deps,
      () => this.live,
      (id, event) => {
        if (!this.store.running(id)) this.trigger(id, event, "file");
      },
      (error) => this.report(error),
    );
  }
  start(): void {
    if (!this.lifecycle.beginStart()) return;
    this.generation++;
    const generation = this.generation;
    this.controller = new AbortController();
    try {
      for (const job of this.store.jobs()) {
        try {
          const ready = { fired: false };
          const prepared = this.runtime.prepare(job.automation, this.hooks(generation, ready));
          this.runtime.install(prepared);
          if (prepared.watchError !== undefined)
            this.persistWatchError(
              job.automation.id,
              prepared.revision,
              generation,
              prepared.watchError,
            );
          else if (job.automation.trigger.kind === "file")
            this.clearIfReady(job.automation.id, prepared.revision, generation, ready);
        } catch (error) {
          this.isolateJob(job, generation, error);
        }
        if (!this.live) break;
        if (
          job.automation.trigger.kind === "schedule" &&
          job.nominal !== null &&
          job.due !== null
        ) {
          try {
            this.recoverSchedule(job);
          } catch (error) {
            this.isolateJob(job, generation, error);
          }
          if (!this.live) break;
        }
      }
      for (const { run, input } of this.store.active()) {
        if (!this.live) break;
        try {
          this.executions.restore(run, input);
        } catch (error) {
          this.report(error);
          if (!this.live) break;
        }
      }
      this.arm();
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      if (this.lifecycle.endStart()) this.stop();
    }
  }
  private isolateJob(job: JobMetadata, generation: number, error: unknown): void {
    if (!this.live || generation !== this.generation) return;
    try {
      this.store.saveTriggerError(job.automation.id, {
        message: message(error),
        at: this.deps.now(),
      });
    } catch (persistError) {
      this.report(persistError);
    }
    try {
      this.store.advance(job.automation.id, job.nominal ?? undefined, undefined);
    } catch (persistError) {
      this.report(persistError);
    }
    this.report(error);
  }
  private recoverSchedule(job: JobMetadata): void {
    const recurrence = this.runtime.recurrence(job.automation.id);
    if (!recurrence) throw new Error("Missing recurrence");
    const cursor = Occurrence.parse(this.store.readState(job.automation.id));
    const occurrence = recoverOccurrence(
      job.automation,
      recurrence,
      cursor,
      job.due ?? 0,
      this.deps.now(),
    );
    if (occurrence?.at !== job.nominal)
      this.store.transaction(() => {
        this.store.advance(
          job.automation.id,
          occurrence?.at,
          scheduledDeadline(occurrence, recurrence, job.automation.jitterMs, this.deps.random()),
        );
        this.store.savePoll(job.automation.id, occurrence ?? {});
      });
  }
  stop(): void {
    if (!this.lifecycle.beginStop()) return;
    this.generation++;
    const cancelTimer = this.cancelTimer;
    this.cancelTimer = undefined;
    this.pending.clear();
    this.polling.clear();
    try {
      this.controller.abort();
      this.executions.stop();
      try {
        cancelTimer?.();
      } catch (error) {
        this.report(error);
      }
      this.runtime.stop();
    } finally {
      this.lifecycle.endStop();
    }
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
      this.arm();
    } catch (error) {
      this.report(error);
    }
  }
  put(input: unknown, expectedRevision?: number | null): Automation {
    const automation = normalizeAutomation(input);
    const existing = this.store.definition(automation.id);
    if (expectedRevision === null && existing) throw new Error("Automation already exists");
    if (typeof expectedRevision === "number") {
      if (!existing) throw new Error("Automation is missing");
      const current = this.store.revision(automation.id);
      if (current !== expectedRevision) throw new Error("Automation revision conflict");
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(automation)) {
      if (this.runtime.needsWatch(automation)) this.healWatch(automation);
      return automation;
    }
    const generation = this.generation;
    const ready = { fired: false };
    const prepared = this.runtime.prepare(automation, this.hooks(generation, ready));
    if (prepared.watchError !== undefined) {
      // Replacement failures preserve the previous definition and watcher;
      // new ids persist as unhealthy so one stale workspace cannot block saves.
      if (existing) {
        this.runtime.discard(prepared);
        throw prepared.watchError;
      }
      try {
        this.store.put(automation, undefined, undefined, {}, expectedRevision);
      } catch (error) {
        this.runtime.discard(prepared);
        throw error;
      }
      this.runtime.install(prepared);
      this.persistWatchError(automation.id, prepared.revision, generation, prepared.watchError);
      this.arm();
      return automation;
    }
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
      this.store.put(automation, nominal, due, occurrence ?? {}, expectedRevision);
    } catch (error) {
      this.runtime.discard(prepared);
      throw error;
    }
    this.runtime.install(prepared);
    // File health clears only on confirmed watcher readiness; other triggers
    // are healthy immediately after a successful save.
    if (automation.trigger.kind === "file")
      this.clearIfReady(automation.id, prepared.revision, generation, ready);
    this.arm();
    return automation;
  }
  private hooks(generation: number, ready?: { fired: boolean }) {
    return {
      onReady: (id: string, revision: number) => {
        if (ready) ready.fired = true;
        if (!this.live || generation !== this.generation) return;
        if (this.runtime.current(id) !== revision) return;
        try {
          this.store.clearTriggerError(id);
        } catch (error) {
          this.report(error);
        }
      },
      onError: (id: string, revision: number, error: unknown) => {
        this.persistWatchError(id, revision, generation, error);
      },
    };
  }
  private clearIfReady(
    id: string,
    revision: number,
    generation: number,
    ready: { fired: boolean },
  ): void {
    if (!ready.fired) return;
    if (!this.live || generation !== this.generation) return;
    if (this.runtime.current(id) !== revision) return;
    try {
      this.store.clearTriggerError(id);
    } catch (error) {
      this.report(error);
    }
  }
  private persistWatchError(
    id: string,
    revision: number,
    generation: number,
    error: unknown,
  ): void {
    if (!this.live || generation !== this.generation) return;
    if (this.runtime.current(id) !== revision) return;
    try {
      this.store.saveTriggerError(id, { message: message(error), at: this.deps.now() });
    } catch (persistError) {
      this.report(persistError);
    }
    this.runtime.failed(id, revision);
    this.report(error);
  }
  private saveWatchError(id: string, error: unknown): void {
    try {
      this.store.saveTriggerError(id, { message: message(error), at: this.deps.now() });
    } catch (persistError) {
      this.report(persistError);
    }
    this.report(error);
  }
  private healWatch(automation: Automation): void {
    const generation = this.generation;
    const ready = { fired: false };
    const prepared = this.runtime.prepare(automation, this.hooks(generation, ready));
    if (prepared.watchError !== undefined) {
      this.saveWatchError(automation.id, prepared.watchError);
      return;
    }
    this.runtime.install(prepared);
    this.clearIfReady(automation.id, prepared.revision, generation, ready);
    this.arm();
  }
  remove(id: string, expectedRevision?: number | null): void {
    this.store.remove(id, expectedRevision ?? undefined);
    this.runtime.remove(id);
    this.arm();
  }
  setEnabled(id: string, enabled: boolean, expectedRevision?: number): void {
    const current = this.store.definition(id);
    if (!current) throw new Error("Automation is missing");
    this.put({ ...current, enabled }, expectedRevision);
  }
  list(): Automation[] {
    return this.store.list().map((job) => job.automation);
  }
  catalog(provider: Automation["provider"], workspace: string): { id: string; title: string }[] {
    return this.store.catalog(provider, workspace);
  }
  inbox(limit = 50, before?: number, automationId?: string) {
    return this.store.inbox(limit, before, automationId);
  }
  /**
   * Admit one run. `note` is the person's extra instruction for a manual run, added after the
   * saved prompt; a retried request maps to the same run, so its first note is the one kept.
   */
  trigger(
    id: string,
    input: unknown,
    kind: AutomationRun["trigger"] = "manual",
    note?: string,
  ): AutomationRun {
    if (!this.live) throw new Error("Automation service is stopped");
    const generation = this.generation;
    const automation = this.store.definition(id);
    if (!automation || !automation.enabled) throw new Error("Automation is disabled or missing");
    const event = AutomationEvent.parse(input);
    const admission = this.store.transaction(() => this.admit(automation, event, kind, note));
    if (admission.created) this.publish(admission.run);
    if (admission.admitted && admission.input && this.live && generation === this.generation)
      this.executions.launch(admission.run, admission.input);
    this.arm();
    return admission.run;
  }
  private admit(
    automation: Automation,
    event: AutomationEvent,
    kind: AutomationRun["trigger"],
    note?: string,
  ) {
    const id = kind === "manual" ? manualId(automation.id, event.key) : this.deps.id();
    let input: ExecutionInput | undefined;
    let failure: string | undefined;
    try {
      input = {
        idempotencyKey: id,
        automationId: automation.id,
        title: automation.title,
        provider: automation.provider,
        workspace: automation.workspace,
        worktree: automation.worktree,
        prompt: withRunNote(renderPrompt(automation.prompt, event.variables), note),
        ...(automation.model ? { model: automation.model } : {}),
        ...(automation.effort ? { effort: automation.effort } : {}),
        ...(automation.instance ? { instance: automation.instance } : {}),
        ...(automation.access ? { access: automation.access } : {}),
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
    const deadlines = [job?.due, this.executions.nextDeadline()].filter(
      (value): value is number => value !== undefined && value !== null,
    );
    if (!deadlines.length) return;
    const delay = Math.min(60_000, Math.max(0, Math.min(...deadlines) - this.deps.now()));
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
      this.executions.expire();
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
        } else {
          try {
            this.scheduled(job);
          } catch (error) {
            this.isolateJob(job, this.generation, error);
          }
        }
      }
    } finally {
      this.ticking = false;
      this.arm();
    }
  }
  private scheduled(job: JobMetadata): void {
    const generation = this.generation;
    const recurrence = this.runtime.recurrence(job.automation.id);
    if (!recurrence || job.nominal === null) {
      this.isolateJob(job, generation, new Error("Invalid scheduled job"));
      return;
    }
    // Compute before admission so any evaluation error cannot partially advance the cursor.
    let occurrence: Occurrence | undefined;
    try {
      occurrence = recurrence.seek(
        Math.max(job.nominal, this.deps.now()),
        Occurrence.parse(this.store.readState(job.automation.id)),
      );
    } catch (error) {
      // Evaluation failure parks the schedule without hot-loop retries;
      // exhaustion returns undefined below and finishes cleanly without an error.
      try {
        this.store.saveTriggerError(job.automation.id, {
          message: message(error),
          at: this.deps.now(),
        });
      } catch (persistError) {
        this.report(persistError);
      }
      try {
        this.store.advance(job.automation.id, job.nominal ?? undefined, undefined);
      } catch (persistError) {
        this.report(persistError);
      }
      this.report(error);
      return;
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
        this.live &&
        generation === this.generation &&
        this.runtime.current(job.automation.id) === revision
      )
        this.store.transaction(() => {
          if (result.changed) this.store.savePoll(job.automation.id, result.state);
          this.store.clearPollError(job.automation.id);
          this.store.clearTriggerError(job.automation.id);
        });
    } catch (error) {
      if (
        this.live &&
        generation === this.generation &&
        this.runtime.current(job.automation.id) === revision
      ) {
        const failure = { message: message(error), at: this.deps.now() };
        try {
          this.store.savePollError(job.automation.id, failure);
        } catch (persistError) {
          this.report(persistError);
        }
        try {
          this.store.saveTriggerError(job.automation.id, failure);
        } catch (persistError) {
          this.report(persistError);
        }
      }
      this.report(error);
    }
  }
  retry(id: string, expectedRevision?: number): void {
    if (!this.live) throw new Error("Automation service is stopped");
    const automation = this.store.definition(id);
    if (!automation) throw new Error("Automation is missing");
    if (typeof expectedRevision === "number") {
      const current = this.store.revision(id);
      if (current !== expectedRevision) throw new Error("Automation revision conflict");
    }
    if (!automation.enabled) throw new Error("Automation is disabled or missing");
    const generation = this.generation;
    const trigger = automation.trigger;
    if (trigger.kind === "file") {
      const ready = { fired: false };
      const prepared = this.runtime.prepare(automation, this.hooks(generation, ready));
      if (prepared.watchError !== undefined) {
        this.saveWatchError(id, prepared.watchError);
        throw prepared.watchError;
      }
      this.runtime.install(prepared);
      this.clearIfReady(id, prepared.revision, generation, ready);
      this.arm();
      return;
    }
    if (trigger.kind === "schedule") {
      if (this.store.metadata(id)?.triggerError === undefined) return;
      let prepared: ReturnType<AutomationRuntime["prepare"]>;
      try {
        prepared = this.runtime.prepare(automation, this.hooks(generation));
      } catch (error) {
        try {
          this.store.saveTriggerError(id, { message: message(error), at: this.deps.now() });
        } catch (persistError) {
          this.report(persistError);
        }
        try {
          this.store.advance(id, this.store.metadata(id)?.nominal ?? undefined, undefined);
        } catch (persistError) {
          this.report(persistError);
        }
        this.report(error);
        throw error;
      }
      const recurrence = prepared.recurrence;
      if (!recurrence) {
        this.runtime.discard(prepared);
        throw new Error("Invalid scheduled job");
      }
      let occurrence: Occurrence | undefined;
      try {
        occurrence = recurrence.seek(
          this.deps.now() - 1,
          Occurrence.parse(this.store.readState(id)),
        );
      } catch (error) {
        this.runtime.discard(prepared);
        try {
          this.store.saveTriggerError(id, { message: message(error), at: this.deps.now() });
        } catch (persistError) {
          this.report(persistError);
        }
        try {
          const nominal = this.store.metadata(id)?.nominal ?? undefined;
          this.store.advance(id, nominal, undefined);
        } catch (persistError) {
          this.report(persistError);
        }
        this.report(error);
        throw error;
      }
      const due = occurrence
        ? scheduledDeadline(occurrence, recurrence, automation.jitterMs, this.deps.random())
        : undefined;
      try {
        this.store.transaction(() => {
          this.store.advance(id, occurrence?.at, due);
          this.store.savePoll(id, occurrence ?? {});
          this.store.clearTriggerError(id);
        });
      } catch (error) {
        this.runtime.discard(prepared);
        throw error;
      }
      this.runtime.install(prepared);
      this.arm();
      return;
    }
    if (trigger.kind === "github") {
      try {
        this.store.advance(id, this.store.metadata(id)?.nominal ?? undefined, this.deps.now());
      } catch (error) {
        this.report(error);
        throw error;
      }
      this.arm();
      return;
    }
  }
  handle(input: unknown): AutomationResponse {
    const request = AutomationRequest.parse(input);
    try {
      const base = { type: "automation.result" as const, requestId: request.requestId, ok: true };
      switch (request.type) {
        case "automation.put":
          this.put(request.automation, request.expectedRevision);
          return base;
        case "automation.remove":
          this.remove(request.id, request.expectedRevision);
          return base;
        case "automation.setEnabled":
          this.setEnabled(request.id, request.enabled, request.expectedRevision);
          return base;
        case "automation.retry":
          this.retry(request.id, request.expectedRevision);
          return base;
        case "automation.run":
          return {
            ...base,
            run: this.trigger(
              request.id,
              { key: `manual:${request.requestId}`, variables: request.variables },
              "manual",
              request.message,
            ),
          };
        case "automation.list": {
          const jobs = this.store.list();
          const runs = this.store.latestRuns();
          return {
            ...base,
            automations: jobs.map((job) => job.automation),
            schedules: jobs.map((job) => ({
              id: job.automation.id,
              nextRunAt: this.live ? job.due : null,
              revision: job.revision,
              lastPollError: job.lastPollError,
              triggerError: job.triggerError,
              lastRun: runs.get(job.automation.id),
            })),
          };
        }
        case "automation.inbox":
          return {
            ...base,
            inbox: this.inbox(request.limit, request.before, request.automationId),
          };
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
