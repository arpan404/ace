import { DatabaseSync, type StatementSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";
import { Automation, AutomationRun, AutomationInbox, type AutomationEvent } from "@ace/protocol";
import { canAdmit } from "./decisions.ts";
import type { ExecutionInput, ExecutionResult } from "./contracts.ts";

const JobMetadata = z.object({
  automation: Automation,
  nominal: z.number().nullable(),
  due: z.number().nullable(),
});
export type JobMetadata = z.infer<typeof JobMetadata>;
const Job = JobMetadata.extend({ state: z.unknown() });
export type Job = z.infer<typeof Job>;
const Input = z.object({
  idempotencyKey: z.string(),
  automationId: z.string(),
  provider: Automation.shape.provider,
  model: z.string().optional(),
  workspace: z.string(),
  prompt: z.string().max(65_536),
  worktree: z.boolean(),
});
export class AutomationStore {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS automation_jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL, nominal INTEGER, due INTEGER, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_state(id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_due ON automation_jobs(due,id) WHERE due IS NOT NULL;
      CREATE INDEX IF NOT EXISTS automation_schedule_due ON automation_jobs(due,id) WHERE due IS NOT NULL AND json_extract(body,'$.trigger.kind')='schedule';
      CREATE TABLE IF NOT EXISTS automation_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, automation_id TEXT NOT NULL, event_key TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, input TEXT, UNIQUE(automation_id,event_key));
      CREATE INDEX IF NOT EXISTS automation_active ON automation_runs(automation_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS automation_status ON automation_runs(status,seq);`);
    // Migrate inline snapshots once; leave the legacy column empty for compatibility.
    this.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO automation_state SELECT id,state FROM automation_jobs;
        UPDATE automation_jobs SET state='{}' WHERE state<>'{}';`);
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
  put(
    automation: Automation,
    nominal: number | undefined,
    due: number | undefined,
    state: unknown = {},
  ): void {
    if (
      !this.definition(automation.id) &&
      Number(this.sql("SELECT COUNT(*) AS n FROM automation_jobs").get()?.n) >= 1000
    )
      throw new Error("Automation limit reached");
    const body = JSON.stringify(automation);
    const snapshot = JSON.stringify(state);
    this.transaction(() => {
      this.sql(
        "INSERT INTO automation_jobs VALUES(?,?,?,?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, nominal=excluded.nominal, due=excluded.due, state=excluded.state",
      ).run(automation.id, body, nominal ?? null, due ?? null, "{}");
      this.sql(
        "INSERT INTO automation_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      ).run(automation.id, snapshot);
    });
  }
  remove(id: string): void {
    this.transaction(() => {
      this.sql("DELETE FROM automation_state WHERE id=?").run(id);
      this.sql("DELETE FROM automation_jobs WHERE id=?").run(id);
    });
  }
  get(id: string): Job | undefined {
    const row = this.sql("SELECT * FROM automation_jobs WHERE id=?").get(id);
    return row
      ? Job.parse({
          automation: JSON.parse(String(row.body)),
          nominal: row.nominal,
          due: row.due,
          state: this.readState(id),
        })
      : undefined;
  }
  definition(id: string): Automation | undefined {
    const row = this.sql("SELECT body FROM automation_jobs WHERE id=?").get(id);
    return row ? Automation.parse(JSON.parse(String(row.body))) : undefined;
  }
  metadata(id: string): JobMetadata | undefined {
    const row = this.sql("SELECT body,nominal,due FROM automation_jobs WHERE id=?").get(id);
    return row
      ? JobMetadata.parse({
          automation: JSON.parse(String(row.body)),
          nominal: row.nominal,
          due: row.due,
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
      "SELECT body,nominal,due FROM automation_jobs ORDER BY id LIMIT 1001",
    ).iterate()) {
      if (++count > 1000) throw new Error("Automation limit exceeded");
      yield JobMetadata.parse({
        automation: JSON.parse(String(row.body)),
        nominal: row.nominal,
        due: row.due,
      });
    }
  }
  list(): JobMetadata[] {
    return [...this.jobs()];
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
  inbox(limit = 50, before?: number): AutomationInbox {
    z.number().int().min(1).max(100).parse(limit);
    if (before !== undefined) z.number().int().positive().parse(before);
    const rows = this.sql(
      "SELECT seq,body FROM automation_runs WHERE seq < ? ORDER BY seq DESC LIMIT ?",
    ).all(before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const page = rows.slice(0, limit);
    return AutomationInbox.parse({
      runs: page.map((row) => AutomationRun.parse(JSON.parse(String(row.body)))),
      before: rows.length > limit ? Number(page.at(-1)?.seq) : null,
    });
  }
}
