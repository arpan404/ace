import {
  Automation,
  AutomationEvent,
  AutomationRequest,
  type AutomationResponse,
  type AutomationRun,
} from "@ace/protocol";
import { ExecutionResult, type Dependencies, type ExecutionInput } from "./contracts.ts";
import { renderPrompt, jitterDeadline, recoverOccurrence } from "./decisions.ts";
import { compileSchedule, Occurrence, type Recurrence } from "./recurrence.ts";
import { AutomationStore, type Job } from "./store.ts";
import { pollGithub } from "./github.ts";
import type { GhClient } from "./gh-process.ts";

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8192);
}
export class AutomationService {
  private store: AutomationStore;
  private deps: Dependencies;
  private gh: GhClient | undefined;
  private recurrences = new Map<string, Recurrence>();
  private revisions = new Map<string, number>();
  private revision = 0;
  private watches = new Map<string, () => void>();
  private cancelTimer: (() => void) | undefined;
  private pending = new Set<Promise<void>>();
  private live = false;
  private controller = new AbortController();
  private generation = 0;
  private ticking = false;
  constructor(store: AutomationStore, deps: Dependencies, gh?: GhClient) {
    this.store = store;
    this.deps = deps;
    this.gh = gh;
  }
  start(): void {
    if (this.live) return;
    this.live = true;
    this.generation++;
    this.controller = new AbortController();
    try {
      for (const job of this.store.list()) {
        this.configure(job.automation);
        if (
          job.automation.trigger.kind === "schedule" &&
          job.nominal !== null &&
          job.due !== null
        ) {
          const recurrence = this.recurrences.get(job.automation.id);
          if (!recurrence) throw new Error("Missing recurrence");
          const cursor = Occurrence.parse(job.state);
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
                jitterDeadline(occurrence?.at, job.automation.jitterMs, this.deps.random()),
              );
              this.store.savePoll(job.automation.id, occurrence ?? {});
            });
        }
      }
      for (const { run, input } of this.store.active()) this.launch(run, input, true);
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
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    for (const unsubscribe of this.watches.values()) unsubscribe();
    this.watches.clear();
    this.recurrences.clear();
    this.revisions.clear();
  }
  /** Tests and orderly shutdown can await already admitted work, without polling. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
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
  private configure(automation: Automation): void {
    this.revisions.set(automation.id, ++this.revision);
    this.watches.get(automation.id)?.();
    this.watches.delete(automation.id);
    this.recurrences.delete(automation.id);
    if (!automation.enabled) return;
    if (automation.trigger.kind === "schedule")
      this.recurrences.set(automation.id, compileSchedule(automation.trigger.schedule));
    if (automation.trigger.kind === "file" && this.live && this.deps.workspace) {
      this.watches.set(
        automation.id,
        this.deps.workspace.subscribe(
          automation.workspace,
          automation.trigger.paths,
          async (event) => {
            this.trigger(automation.id, event, "file");
          },
        ),
      );
    }
  }
  put(input: unknown): Automation {
    const automation = Automation.parse(input);
    const existing = this.store.get(automation.id);
    if (existing && JSON.stringify(existing.automation) === JSON.stringify(automation))
      return automation;
    const recurrence =
      automation.trigger.kind === "schedule"
        ? compileSchedule(automation.trigger.schedule)
        : undefined;
    const occurrence =
      automation.enabled && recurrence ? recurrence.seek(this.deps.now() - 1) : undefined;
    const nominal = occurrence?.at;
    const due = !automation.enabled
      ? undefined
      : automation.trigger.kind === "github"
        ? this.deps.now()
        : jitterDeadline(nominal, automation.jitterMs, this.deps.random());
    this.store.put(automation, nominal, due, occurrence ?? {});
    this.configure(automation);
    this.arm();
    return automation;
  }
  remove(id: string): void {
    this.store.remove(id);
    this.watches.get(id)?.();
    this.watches.delete(id);
    this.recurrences.delete(id);
    this.revisions.delete(id);
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
    const job = this.store.get(id);
    if (!job || !job.automation.enabled) throw new Error("Automation is disabled or missing");
    const event = AutomationEvent.parse(input);
    const admission = this.store.transaction(() => this.admit(job.automation, event, kind));
    if (admission.created) this.publish(admission.run);
    if (admission.admitted && admission.input) this.launch(admission.run, admission.input, false);
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
  private launch(run: AutomationRun, input: ExecutionInput, recover: boolean): void {
    const generation = this.generation;
    const operation = async () => {
      try {
        let recovered: ExecutionResult | undefined;
        if (recover) {
          try {
            recovered = await this.deps.executor.recover(input.idempotencyKey);
          } catch (error) {
            // Uncertain recovery must keep the slot occupied by potentially live work.
            this.report(error);
            return;
          }
        }
        if (!this.live || generation !== this.generation) return;
        const outcome = ExecutionResult.parse(
          recovered ?? (await this.deps.executor.execute(input)),
        );
        if (this.live && generation === this.generation) {
          const finished = this.store.finish(run.id, this.deps.now(), outcome);
          if (finished) this.publish(finished);
        }
      } catch (error) {
        if (this.live && generation === this.generation) {
          const finished = this.store.finish(run.id, this.deps.now(), {
            status: "failed",
            result: message(error),
          });
          if (finished) this.publish(finished);
        }
      }
    };
    this.track(operation());
  }
  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.live || this.ticking) return;
    const job = this.store.next();
    if (job?.due === null || job?.due === undefined) return;
    const delay = Math.min(2_147_483_647, Math.max(0, job.due - this.deps.now()));
    this.cancelTimer = this.deps.timer.arm(delay, () => {
      this.cancelTimer = undefined;
      const operation = this.tick().catch((error) => this.report(error));
      this.track(operation);
      return operation;
    });
  }
  private async tick(): Promise<void> {
    this.ticking = true;
    try {
      // A bounded batch yields to I/O if a large number of jobs share a deadline.
      for (let i = 0; i < 100 && this.live; i++) {
        const job = this.store.next();
        if (!job || job.due === null || job.due > this.deps.now()) break;
        if (job.automation.trigger.kind === "github") await this.poll(job);
        else this.scheduled(job);
      }
    } finally {
      this.ticking = false;
      this.arm();
    }
  }
  private scheduled(job: Job): void {
    const recurrence = this.recurrences.get(job.automation.id);
    if (!recurrence || job.nominal === null) throw new Error("Invalid scheduled job");
    // Compute before admission so any evaluation error cannot partially advance the cursor.
    let occurrence: Occurrence | undefined;
    try {
      occurrence = recurrence.seek(
        Math.max(job.nominal, this.deps.now()),
        Occurrence.parse(job.state),
      );
    } catch (error) {
      this.store.advance(job.automation.id, undefined, undefined);
      throw error;
    }
    const nominal = occurrence?.at;
    const due = jitterDeadline(nominal, job.automation.jitterMs, this.deps.random());
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
    if (admission.admitted && admission.input) this.launch(admission.run, admission.input, false);
  }
  private async poll(job: Job): Promise<void> {
    const generation = this.generation;
    const revision = this.revisions.get(job.automation.id);
    const trigger = job.automation.trigger;
    if (trigger.kind !== "github") return;
    // Advance before I/O to bound repeated failures and prevent a busy loop.
    this.store.advance(job.automation.id, undefined, this.deps.now() + trigger.pollIntervalMs);
    try {
      if (!this.gh) throw new Error("GitHub client is not configured");
      const result = await pollGithub(this.gh, trigger, job.state, this.controller.signal);
      if (!this.live || generation !== this.generation) return;
      // An edit/removal while gh was in flight invalidates this response.
      if (this.revisions.get(job.automation.id) !== revision) return;
      for (const event of result.events) this.trigger(job.automation.id, event, "github");
      if (result.changed) this.store.savePoll(job.automation.id, result.state);
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
