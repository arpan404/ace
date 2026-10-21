import { normalizeAutomation } from "./definition.ts";
import { DatabaseSync, type StatementSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";
import {
  Automation,
  AutomationRun,
  AutomationInbox,
  type AutomationEvent,
  AutomationPollError,
  AutomationTriggerError,
  maxMessageBytes,
} from "@ace/protocol";
import { canAdmit } from "./decisions.ts";
import type { ExecutionInput, ExecutionResult } from "./contracts.ts";

const JobMetadata = z.object({
  automation: z.unknown().transform(normalizeAutomation),
  nominal: z.number().nullable(),
  due: z.number().nullable(),
  revision: z.number().int().positive(),
  lastPollError: AutomationPollError.optional(),
  triggerError: AutomationTriggerError.optional(),
});
export type JobMetadata = z.infer<typeof JobMetadata>;
const Job = JobMetadata.extend({ state: z.unknown() });
const CatalogMetadata = Automation.pick({
  id: true,
  title: true,
  workspace: true,
  provider: true,
}).extend({ enabled: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1) });
export type Job = z.infer<typeof Job>;
const Input = z.object({
  idempotencyKey: z.string(),
  automationId: z.string(),
  title: Automation.shape.title.optional(),
  provider: Automation.shape.provider,
  model: z.string().optional(),
  access: Automation.shape.access,
  workspace: z.string(),
  prompt: z.string().max(maxMessageBytes),
  worktree: z.boolean(),
});
export class AutomationStore {
  private catalogCache: z.infer<typeof CatalogMetadata>[] | undefined;
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;
      CREATE TABLE IF NOT EXISTS automation_jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL, nominal INTEGER, due INTEGER, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_state(id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_due ON automation_jobs(due,id) WHERE due IS NOT NULL;
      CREATE INDEX IF NOT EXISTS automation_schedule_due ON automation_jobs(due,id) WHERE due IS NOT NULL AND json_extract(body,'$.trigger.kind')='schedule';
      CREATE TABLE IF NOT EXISTS automation_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, automation_id TEXT NOT NULL, event_key TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, input TEXT, UNIQUE(automation_id,event_key));
      CREATE TABLE IF NOT EXISTS automation_poll_errors(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_trigger_errors(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_revisions(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_history ON automation_runs(automation_id,seq);
      CREATE INDEX IF NOT EXISTS automation_active ON automation_runs(automation_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS automation_status ON automation_runs(status,seq);`);
    // Migrate inline snapshots once; leave the legacy column empty for compatibility.
    // Backfill durable CAS revisions for definitions stored before revisions existed.
    this.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO automation_state SELECT id,state FROM automation_jobs;
        UPDATE automation_jobs SET state='{}' WHERE state<>'{}';
        INSERT OR IGNORE INTO automation_revisions SELECT id,1 FROM automation_jobs;`);
    });
  }
  close(): void {
    this.statements.clear();
    this.db.close();
  }
  private sql(sql: string): StatementSync {
    let result = this.statements.get(sql);
    if (!result) {
      result = this.db.prepare(sql);
      this.statements.set(sql, result);
    }
    return result;
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (result instanceof Promise) throw new Error("Automation transactions must be synchronous");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  revision(id: string): number | undefined {
    const row = this.sql("SELECT revision FROM automation_revisions WHERE id=?").get(id);
    return row ? Number(row.revision) : undefined;
  }
  put(
    automation: Automation,
    nominal: number | undefined,
    due: number | undefined,
    state: unknown = {},
    expectedRevision?: number | null,
  ): number {
    const body = JSON.stringify(normalizeAutomation(automation));
    const snapshot = JSON.stringify(state);
    const revision = this.transaction(() => {
      const stored = this.sql("SELECT revision FROM automation_revisions WHERE id=?").get(
        automation.id,
      );
      const storedRevision = stored ? Number(stored.revision) : undefined;
      const live = this.sql("SELECT 1 AS found FROM automation_jobs WHERE id=?").get(automation.id);
      if (expectedRevision === null) {
        if (live) throw new Error("Automation already exists");
      } else if (typeof expectedRevision === "number") {
        if (!live) throw new Error("Automation is missing");
        if (storedRevision !== expectedRevision) throw new Error("Automation revision conflict");
      }
      if (!live && Number(this.sql("SELECT COUNT(*) AS n FROM automation_jobs").get()?.n) >= 1000)
        throw new Error("Automation limit reached");
      const next = (storedRevision ?? 0) + 1;
      this.sql(
        "INSERT INTO automation_jobs VALUES(?,?,?,?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, nominal=excluded.nominal, due=excluded.due, state=excluded.state",
      ).run(automation.id, body, nominal ?? null, due ?? null, "{}");
      if (automation.trigger.kind !== "github") this.clearPollError(automation.id);
      // File trigger health survives saves until the watcher reports readiness;
      // other triggers are healthy immediately after a successful save.
      if (automation.trigger.kind !== "file") this.clearTriggerError(automation.id);
      this.sql(
        "INSERT INTO automation_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      ).run(automation.id, snapshot);
      this.sql(
        "INSERT INTO automation_revisions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
      ).run(automation.id, next);
      return next;
    });
    this.catalogCache = undefined;
    return revision;
  }
  remove(id: string, expectedRevision?: number | null): void {
    // Null on remove stays idempotent (same as omitted); a number enforces CAS,
    // including against the tombstone so stale edits cannot resurrect deleted ids.
    const changed = this.transaction(() => {
      const stored = this.sql("SELECT revision FROM automation_revisions WHERE id=?").get(id);
      const storedRevision = stored ? Number(stored.revision) : undefined;
      const live = this.sql("SELECT 1 AS found FROM automation_jobs WHERE id=?").get(id);
      if (typeof expectedRevision === "number") {
        if (storedRevision !== expectedRevision) throw new Error("Automation revision conflict");
        if (!live) return false;
      } else if (!live) return false;
      this.clearPollError(id);
      this.clearTriggerError(id);
      this.sql("DELETE FROM automation_state WHERE id=?").run(id);
      this.sql("DELETE FROM automation_jobs WHERE id=?").run(id);
      this.sql(
        "INSERT INTO automation_revisions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
      ).run(id, (storedRevision ?? 0) + 1);
      return true;
    });
    if (changed) this.catalogCache = undefined;
  }
  get(id: string): Job | undefined {
    const row = this.sql("SELECT * FROM automation_jobs WHERE id=?").get(id);
    if (!row) return undefined;
    const poll = this.sql("SELECT body FROM automation_poll_errors WHERE id=?").get(id);
    const trigger = this.sql("SELECT body FROM automation_trigger_errors WHERE id=?").get(id);
    return Job.parse({
      automation: JSON.parse(String(row.body)),
      nominal: row.nominal,
      due: row.due,
      revision: this.revision(id) ?? 1,
      lastPollError: poll ? AutomationPollError.parse(JSON.parse(String(poll.body))) : undefined,
      triggerError: trigger
        ? AutomationTriggerError.parse(JSON.parse(String(trigger.body)))
        : undefined,
      state: this.readState(id),
    });
  }
  definition(id: string): Automation | undefined {
    const row = this.sql("SELECT body FROM automation_jobs WHERE id=?").get(id);
    return row ? Automation.parse(JSON.parse(String(row.body))) : undefined;
  }
  metadata(id: string): JobMetadata | undefined {
    const row = this.sql(
      "SELECT j.body,j.nominal,j.due,r.revision,e.body AS pollError,t.body AS triggerError FROM automation_jobs j LEFT JOIN automation_revisions r ON r.id=j.id LEFT JOIN automation_poll_errors e ON e.id=j.id LEFT JOIN automation_trigger_errors t ON t.id=j.id WHERE j.id=?",
    ).get(id);
    return row
      ? JobMetadata.parse({
          automation: JSON.parse(String(row.body)),
          nominal: row.nominal,
          due: row.due,
          revision: Number(row.revision ?? 1),
          lastPollError: row.pollError
            ? AutomationPollError.parse(JSON.parse(String(row.pollError)))
            : undefined,
          triggerError: row.triggerError
            ? AutomationTriggerError.parse(JSON.parse(String(row.triggerError)))
            : undefined,
        })
      : undefined;
  }
  readState(id: string): unknown {
    const row = this.sql("SELECT state FROM automation_state WHERE id=?").get(id);
    if (!row) throw new Error("Automation is missing");
    const state: unknown = JSON.parse(String(row.state));
    return state;
  }
  *jobs(): Iterable<JobMetadata> {
    let count = 0;
    for (const row of this.sql(
      "SELECT j.body,j.nominal,j.due,r.revision,e.body AS pollError,t.body AS triggerError FROM automation_jobs j LEFT JOIN automation_revisions r ON r.id=j.id LEFT JOIN automation_poll_errors e ON e.id=j.id LEFT JOIN automation_trigger_errors t ON t.id=j.id ORDER BY j.id LIMIT 1001",
    ).iterate()) {
      if (++count > 1000) throw new Error("Automation limit exceeded");
      yield JobMetadata.parse({
        automation: JSON.parse(String(row.body)),
        nominal: row.nominal,
        due: row.due,
        revision: Number(row.revision ?? 1),
        lastPollError: row.pollError
          ? AutomationPollError.parse(JSON.parse(String(row.pollError)))
          : undefined,
        triggerError: row.triggerError
          ? AutomationTriggerError.parse(JSON.parse(String(row.triggerError)))
          : undefined,
      });
    }
  }
  list(): JobMetadata[] {
    return [...this.jobs()];
  }
  /** Catalog reads need names, never prompt bodies, scheduling state or run history. */
  catalog(provider: Automation["provider"], workspace: string): { id: string; title: string }[] {
    this.catalogCache ??= this.sql(`SELECT id,
      json_extract(body,'$.title') AS title, json_extract(body,'$.enabled') AS enabled,
      json_extract(body,'$.workspace') AS workspace, json_extract(body,'$.provider') AS provider
      FROM automation_jobs ORDER BY id LIMIT 1000`)
      .all()
      .map((row) => CatalogMetadata.parse(row));
    return this.catalogCache
      .filter((a) => a.enabled && a.provider === provider && a.workspace === workspace)
      .slice(0, 128)
      .map(({ id, title }) => ({ id, title }));
  }
  next(excluded: readonly string[] = []): JobMetadata | undefined {
    if (excluded.length > 4) throw new Error("Too many excluded polls");
    const row = this.sql(
      "SELECT id FROM automation_jobs WHERE due IS NOT NULL AND id NOT IN(?,?,?,?) ORDER BY due,id LIMIT 1",
    ).get(excluded[0] ?? "", excluded[1] ?? "", excluded[2] ?? "", excluded[3] ?? "");
    return row ? this.metadata(String(row.id)) : undefined;
  }
  nextScheduled(): JobMetadata | undefined {
    const row = this.sql(
      "SELECT id FROM automation_jobs WHERE due IS NOT NULL AND json_extract(body,'$.trigger.kind')='schedule' ORDER BY due,id LIMIT 1",
    ).get();
    return row ? this.metadata(String(row.id)) : undefined;
  }
  advance(id: string, nominal: number | undefined, due: number | undefined): void {
    this.sql("UPDATE automation_jobs SET nominal=?,due=? WHERE id=?").run(
      nominal ?? null,
      due ?? null,
      id,
    );
  }
  savePoll(id: string, state: unknown): void {
    this.sql("UPDATE automation_state SET state=? WHERE id=?").run(JSON.stringify(state), id);
  }
  savePollError(id: string, error: AutomationPollError): void {
    this.sql(
      "INSERT INTO automation_poll_errors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    ).run(id, JSON.stringify(AutomationPollError.parse(error)));
  }
  clearPollError(id: string): void {
    this.sql("DELETE FROM automation_poll_errors WHERE id=?").run(id);
  }
  saveTriggerError(id: string, error: AutomationTriggerError): void {
    this.sql(
      "INSERT INTO automation_trigger_errors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    ).run(id, JSON.stringify(AutomationTriggerError.parse(error)));
  }
  clearTriggerError(id: string): void {
    this.sql("DELETE FROM automation_trigger_errors WHERE id=?").run(id);
  }
  latestRun(automationId: string): AutomationRun | undefined {
    const row = this.sql(
      "SELECT body FROM automation_runs WHERE automation_id=? ORDER BY seq DESC LIMIT 1",
    ).get(automationId);
    return row ? AutomationRun.parse(JSON.parse(String(row.body))) : undefined;
  }
  /** One indexed lookup per live automation, without scanning run history. */
  latestRuns(): Map<string, AutomationRun> {
    const runs = new Map<string, AutomationRun>();
    for (const row of this.sql(
      `SELECT j.id AS aid,
        (SELECT r.body FROM automation_runs r
          WHERE r.automation_id=j.id ORDER BY r.seq DESC LIMIT 1) AS runBody
        FROM automation_jobs j ORDER BY j.id LIMIT 1001`,
    ).iterate()) {
      if (row.runBody === null || row.runBody === undefined) continue;
      runs.set(String(row.aid), AutomationRun.parse(JSON.parse(String(row.runBody))));
    }
    return runs;
  }
  running(id: string): boolean {
    return (
      this.sql(
        "SELECT 1 FROM automation_runs WHERE automation_id=? AND status='running' LIMIT 1",
      ).get(id) !== undefined
    );
  }
  private prune(id: string): void {
    this.sql(
      "DELETE FROM automation_runs WHERE automation_id=? AND status<>'running' AND seq NOT IN (SELECT seq FROM automation_runs WHERE automation_id=? ORDER BY seq DESC LIMIT 1000)",
    ).run(id, id);
  }
  claim(
    automation: Automation,
    event: AutomationEvent,
    trigger: AutomationRun["trigger"],
    id: string,
    now: number,
    input: ExecutionInput | undefined,
    failure?: string,
  ): { run: AutomationRun; admitted: boolean; created: boolean } {
    const existing = this.sql(
      "SELECT body FROM automation_runs WHERE automation_id=? AND event_key=?",
    ).get(automation.id, event.key);
    if (existing)
      return {
        run: AutomationRun.parse(JSON.parse(String(existing.body))),
        admitted: false,
        created: false,
      };
    const active = Number(
      this.sql(
        "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id=? AND status='running'",
      ).get(automation.id)?.n,
    );
    const total = Number(
      this.sql("SELECT COUNT(*) AS n FROM automation_runs WHERE status='running'").get()?.n,
    );
    const admitted =
      failure === undefined &&
      input !== undefined &&
      canAdmit(active, automation.concurrency) &&
      total < 256;
    const status = failure !== undefined ? "failed" : admitted ? "running" : "skipped";
    const run = AutomationRun.parse({
      id,
      automationId: automation.id,
      title: automation.title,
      eventKey: event.key,
      trigger,
      status,
      startedAt: now,
      ...(admitted ? {} : { finishedAt: now, result: failure ?? "Concurrency limit reached" }),
    });
    if (trigger === "file" && status === "skipped") return { run, admitted: false, created: false };
    this.sql(
      "INSERT INTO automation_runs(id,automation_id,event_key,status,body,input) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      automation.id,
      event.key,
      status,
      JSON.stringify(run),
      input ? JSON.stringify(input) : null,
    );
    this.prune(automation.id);
    return { run, admitted, created: true };
  }
  finish(
    id: string,
    now: number,
    outcome: ExecutionResult | { status: "failed"; result: string },
  ): AutomationRun | undefined {
    const row = this.sql("SELECT body FROM automation_runs WHERE id=? AND status='running'").get(
      id,
    );
    if (!row) return undefined;
    const run = AutomationRun.parse({
      ...AutomationRun.parse(JSON.parse(String(row.body))),
      ...outcome,
      finishedAt: now,
    });
    this.sql("UPDATE automation_runs SET status=?,body=? WHERE id=? AND status='running'").run(
      run.status,
      JSON.stringify(run),
      id,
    );
    this.prune(run.automationId);
    return run;
  }
  active(): { run: AutomationRun; input: ExecutionInput }[] {
    return this.sql("SELECT body,input FROM automation_runs WHERE status='running' LIMIT 256")
      .all()
      .map((row) => ({
        run: AutomationRun.parse(JSON.parse(String(row.body))),
        input: Input.parse(JSON.parse(String(row.input))),
      }));
  }
  inbox(limit = 50, before?: number, automationId?: string): AutomationInbox {
    z.number().int().min(1).max(100).parse(limit);
    if (before !== undefined) z.number().int().positive().parse(before);
    const rows =
      automationId === undefined
        ? this.sql(
            "SELECT seq,body FROM automation_runs WHERE seq < ? ORDER BY seq DESC LIMIT ?",
          ).all(before ?? Number.MAX_SAFE_INTEGER, limit + 1)
        : this.sql(
            "SELECT seq,body FROM automation_runs WHERE automation_id=? AND seq < ? ORDER BY seq DESC LIMIT ?",
          ).all(automationId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const page = rows.slice(0, limit);
    return AutomationInbox.parse({
      runs: page.map((row) => AutomationRun.parse(JSON.parse(String(row.body)))),
      before: rows.length > limit ? Number(page.at(-1)?.seq) : null,
    });
  }
}
