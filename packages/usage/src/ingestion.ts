import { SessionTotals } from "./session-totals.ts";
import { z } from "zod";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { UsageBatch, type UsageEvent } from "./events.ts";
import { Counts, type Counts as CountValues } from "./counters.ts";
import { accountSample, counterPolicy } from "./accounting.ts";
import { upsertDaily, upsertSkillDaily } from "./database.ts";
import { retainedDay } from "./retention.ts";
const Agent = z.object({
  thread: z.string(),
  parent: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string(),
  run: z.string(),
  workspace: z.string(),
  skills: z.string().nullable(),
});
const Skills = z.array(z.string()).catch([]);
/** The thread's current turn skills, stored as a JSON array; anything unreadable counts as none. */
function turnSkills(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    return Skills.parse(JSON.parse(stored));
  } catch {
    return [];
  }
}
export type DailyIncrement = CountValues & {
  day: string;
  thread: string;
  agent: string;
  provider: string;
  account: string;
  model: string;
  workspace: string;
  billing: string;
};
export class Ingestion {
  private readonly sessionTotals: SessionTotals;
  private readonly db: DatabaseSync;
  private readonly day: (at: number) => string;
  private readonly retentionDays: number;
  private readonly incrementRetentionDays: number;
  private readonly statements = new Map<string, StatementSync>();
  constructor(
    db: DatabaseSync,
    day: (at: number) => string,
    retentionDays: number,
    incrementRetentionDays: number,
  ) {
    this.db = db;
    this.sessionTotals = new SessionTotals(db);
    this.day = day;
    this.retentionDays = retentionDays;
    this.incrementRetentionDays = incrementRetentionDays;
  }
  private sql(query: string): StatementSync {
    let s = this.statements.get(query);
    if (!s) {
      s = this.db.prepare(query);
      this.statements.set(query, s);
    }
    return s;
  }
  ingest(input: unknown): number {
    const batch = UsageBatch.parse(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cursor = Number(this.sql("SELECT cursor FROM usage_meta WHERE id=1").get()?.cursor);
      if (batch.afterSeq > cursor) throw new Error("Usage replay gap");
      let deltas: DailyIncrement[] = [];
      let skillDeltas: (DailyIncrement & { skill: string })[] = [];
      for (const event of batch.events)
        if (event.seq > cursor) {
          const applied = this.apply(event);
          if (event.payload.type === "thread.deleted") {
            // Deferred rollups from this same batch must not resurrect a deleted thread.
            deltas = deltas.filter((d) => d.thread !== event.threadId);
            skillDeltas = skillDeltas.filter((d) => d.thread !== event.threadId);
          }
          if (!applied) continue;
          const [delta, skills] = applied;
          deltas.push(delta);
          for (const skill of skills) skillDeltas.push({ ...delta, skill });
        }
      if (deltas.length) this.sql(upsertDaily).run(JSON.stringify(deltas));
      if (skillDeltas.length) this.sql(upsertSkillDaily).run(JSON.stringify(skillDeltas));
      const latest = Number(
        this.sql("SELECT latest_at FROM usage_meta WHERE id=1").get()?.latest_at,
      );
      const retained = retainedDay(this.day(latest), this.retentionDays);
      this.sql("DELETE FROM usage_daily WHERE day<?").run(retained);
      this.sql("DELETE FROM usage_skill_daily WHERE day<?").run(retained);
      this.sql("DELETE FROM usage_increments WHERE at<?").run(
        Math.max(0, latest - this.incrementRetentionDays * 86_400_000),
      );
      const next = Math.max(cursor, batch.throughSeq);
      this.sql("UPDATE usage_meta SET cursor=? WHERE id=1").run(next);
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private link(thread: string, agent: string, parent: string | null): void {
    if (parent !== null) {
      const row = this.sql("SELECT thread FROM usage_agents WHERE agent=?").get(parent);
      if (row && row.thread !== thread) throw new Error("Cross-thread usage parent");
      const cycle = this.sql(`WITH RECURSIVE ancestors(agent, parent) AS (
        SELECT agent, parent FROM usage_agents WHERE agent=?
        UNION SELECT a.agent, a.parent FROM usage_agents a JOIN ancestors x ON a.agent=x.parent
      ) SELECT 1 FROM ancestors WHERE agent=? LIMIT 1`).get(parent, agent);
      if (parent === agent || cycle) throw new Error("Usage parent cycle");
    }
    const child = this.sql("SELECT 1 FROM usage_agents WHERE parent=? AND thread<>? LIMIT 1").get(
      agent,
      thread,
    );
    if (child) throw new Error("Cross-thread usage child");
  }
  /** The event's daily increment and the skills it also counts for, if it spent anything. */
  private apply(event: UsageEvent): [DailyIncrement, string[]] | undefined {
    const p = event.payload;
    const thread = event.threadId;
    if (p.type === "usage.skipped") {
      this.sql("UPDATE usage_meta SET omitted=omitted+1 WHERE id=1").run();
      return;
    }
    if (p.type === "thread.deleted") {
      this.sessionTotals.delete(thread);
      this.sql(
        "DELETE FROM usage_counters WHERE agent IN (SELECT agent FROM usage_agents WHERE thread=?)",
      ).run(thread);
      this.sql("DELETE FROM usage_agents WHERE thread=?").run(thread);
      this.sql("DELETE FROM usage_daily WHERE thread=?").run(thread);
      this.sql("DELETE FROM usage_skill_daily WHERE thread=?").run(thread);
      this.sql("DELETE FROM usage_increments WHERE thread=?").run(thread);
      this.sql("DELETE FROM usage_threads WHERE thread=?").run(thread);
      return;
    }
    if (p.type === "thread.created") {
      this.sql(
        `INSERT INTO usage_threads(thread, workspace, provider, delegated) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread) DO UPDATE SET delegated=MAX(delegated, excluded.delegated)`,
      ).run(thread, p.workspace, p.provider, p.delegated ? 1 : 0);
      return;
    }
    if (p.type === "thread.delegated") {
      this.sql("UPDATE usage_threads SET delegated=1 WHERE thread=?").run(thread);
      return;
    }
    if (p.type === "turn.asked") {
      // A subagent's prompt is not the person's ask: only the thread's root agent opens turns.
      const asker = this.sql("SELECT parent FROM usage_agents WHERE agent=? AND thread=?").get(
        p.agent,
        thread,
      );
      if (asker?.parent != null) return;
      this.sql(
        "UPDATE usage_threads SET skills=?, automation=COALESCE(automation, ?) WHERE thread=?",
      ).run(p.skills.length ? JSON.stringify(p.skills) : null, p.automation ?? null, thread);
      return;
    }
    if (p.type === "agent.created") {
      const retained = this.sql("SELECT thread FROM usage_agents WHERE agent=?").get(p.id);
      if (retained && retained.thread !== thread) throw new Error("Cross-thread usage agent");
      this.link(thread, p.id, p.parent);
      // Windowed consumers receive creation again when an old agent becomes active.
      // Refresh its metadata without resetting its run or cumulative counters.
      this.sql(
        `INSERT INTO usage_agents(agent, thread, parent, model, provider) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent) DO UPDATE SET parent=excluded.parent, model=excluded.model, provider=excluded.provider`,
      ).run(p.id, thread, p.parent, p.model, p.provider);
      return;
    }
    if (p.type === "agent.updated") {
      if (p.parent !== undefined) {
        this.link(thread, p.id, p.parent);
        this.sql("UPDATE usage_agents SET parent=? WHERE agent=? AND thread=?").run(
          p.parent,
          p.id,
          thread,
        );
      }
      if (p.model !== undefined)
        this.sql("UPDATE usage_agents SET model=? WHERE agent=? AND thread=?").run(
          p.model,
          p.id,
          thread,
        );
      if (p.provider !== undefined)
        this.sql("UPDATE usage_agents SET provider=? WHERE agent=? AND thread=?").run(
          p.provider,
          p.id,
          thread,
        );
      return;
    }
    if (p.type === "run.started") {
      this.sql("UPDATE usage_agents SET run=? WHERE agent=? AND thread=?").run(
        p.run,
        p.agent,
        thread,
      );
      return;
    }
    if (p.usageScope === "provider_session" || p.usageScope === "model_session") {
      this.sessionTotals.observe(thread, event.at, p);
      return;
    }
    const metadata = this.sql(`SELECT a.thread, a.parent, a.model,
      COALESCE(a.provider,t.provider) AS provider, a.run, t.workspace, t.skills
      FROM usage_agents a JOIN usage_threads t ON t.thread=a.thread
      WHERE a.agent=? AND a.thread=?`).get(p.agentId, thread);
    if (!metadata) {
      // An incompatible retained creation can be omitted without pinning healthy replay.
      this.sql("UPDATE usage_meta SET omitted=omitted+1 WHERE id=1").run();
      return;
    }
    const a = Agent.parse(metadata);
    const provider = a.provider;
    const { mode, scope, tracked } = counterPolicy(p, provider, a.run);
    const previousRow = tracked
      ? this.sql(
          "SELECT input, output, cached, reasoning, write, write1h, cost FROM usage_counters WHERE agent=? AND scope=?",
        ).get(p.agentId, scope)
      : undefined;
    const result = accountSample(
      p,
      provider,
      mode,
      previousRow ? Counts.parse(previousRow) : undefined,
    );
    if (tracked)
      this.sql(
        "INSERT INTO usage_counters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent,scope) DO UPDATE SET input=excluded.input, output=excluded.output, cached=excluded.cached, reasoning=excluded.reasoning, write=excluded.write, write1h=excluded.write1h, cost=excluded.cost",
      ).run(
        p.agentId,
        scope,
        result.next.input,
        result.next.output,
        result.next.cached,
        result.next.reasoning,
        result.next.write,
        result.next.write1h,
        result.next.cost,
      );
    const delta = result.delta;
    if (Object.values(delta).every((v) => v === 0)) return;
    this.sql("UPDATE usage_meta SET latest_at=MAX(latest_at,?) WHERE id=1").run(event.at);
    const billing = p.billingMode ?? "unknown";
    const account = p.accountId ?? "";
    this.sql("INSERT INTO usage_increments VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      event.seq,
      event.at,
      thread,
      account,
      delta.input,
      delta.output,
      billing === "subscription" ? 0 : delta.cost,
    );
    const daily = {
      ...delta,
      cost: billing === "subscription" ? 0 : delta.cost,
      day: this.day(event.at),
      thread,
      agent: p.agentId,
      provider,
      account,
      model: (p.model === undefined ? a.model : p.model) ?? "",
      workspace: a.workspace,
      billing,
    };
    // The whole thread's spend in the turn counts for its skills, subagents included.
    return [daily, turnSkills(a.skills)];
  }
}
