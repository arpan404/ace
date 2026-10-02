import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { isActionableInteraction } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import { InteractionLink } from "./model.ts";
import { OwnerState, type MetadataEvent } from "./metadata.ts";

const OwnerRow = z.object({
  id: z.string().max(200),
  blocking: z.union([z.literal(0), z.literal(1)]),
  eligible: z.union([z.literal(0), z.literal(1)]),
});

export const trackingTables = `
  CREATE TABLE IF NOT EXISTS interaction_owners (thread TEXT NOT NULL, id TEXT NOT NULL, agent TEXT NOT NULL, blocking INTEGER NOT NULL, eligible INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(thread,id));
  CREATE INDEX IF NOT EXISTS interaction_owner ON interaction_owners(thread,agent);
  CREATE INDEX IF NOT EXISTS interaction_eligible ON interaction_owners(thread,eligible,seq);
  CREATE TABLE IF NOT EXISTS agent_status (thread TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread,id));`;

/** Incremental disk indexes: only an affected agent's open interactions are revisited. */
export class InteractionTracking {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  track(event: MetadataEvent): { interactionChanged: boolean; backgroundCompleted: boolean } {
    const p = event.payload;
    let interactionChanged = false,
      backgroundCompleted = false;
    if (p.type === "agent.created" || p.type === "agent.status") {
      const id = p.type === "agent.created" ? p.agent.id : p.agentId;
      const status = p.type === "agent.created" ? p.agent.status : p.status;
      this.statement(
        "INSERT INTO agent_status VALUES(?,?,?) ON CONFLICT(thread,id) DO UPDATE SET body=excluded.body",
      ).run(event.threadId, id, JSON.stringify({ state: status.state }));
      const rows = this.statement(
        "SELECT id,blocking,eligible FROM interaction_owners WHERE thread=? AND agent=?",
      ).iterate(event.threadId, id);
      for (const input of rows) {
        const row = OwnerRow.parse(input);
        const eligible = Number(
          isActionableInteraction({ state: "pending", blocking: row.blocking === 1 }, status),
        );
        if (eligible !== row.eligible) {
          this.statement("UPDATE interaction_owners SET eligible=? WHERE thread=? AND id=?").run(
            eligible,
            event.threadId,
            String(row.id),
          );
          interactionChanged = true;
        }
      }
    } else if (p.type === "interaction.opened" && p.interaction.state === "pending") {
      const link = InteractionLink.parse(p.interaction);
      const inserted = this.statement(
        "INSERT INTO interactions VALUES(?,?,?,?) ON CONFLICT(thread,id) DO NOTHING RETURNING id",
      ).get(event.threadId, p.interaction.id, event.seq, JSON.stringify(link));
      if (inserted) {
        const owner = this.statement("SELECT body FROM agent_status WHERE thread=? AND id=?").get(
          event.threadId,
          p.interaction.agentId,
        );
        const status = owner ? OwnerState.parse(JSON.parse(String(owner.body))) : undefined;
        const eligible = isActionableInteraction(p.interaction, status);
        this.statement("INSERT INTO interaction_owners VALUES(?,?,?,?,?,?)").run(
          event.threadId,
          link.id,
          p.interaction.agentId,
          Number(p.interaction.blocking),
          Number(eligible),
          event.seq,
        );
        interactionChanged = eligible;
      }
    } else if (p.type === "interaction.closed") {
      const removed = this.statement(
        "DELETE FROM interactions WHERE thread=? AND id=? RETURNING id",
      ).get(event.threadId, p.interactionId);
      const owner = this.statement(
        "DELETE FROM interaction_owners WHERE thread=? AND id=? RETURNING eligible",
      ).get(event.threadId, p.interactionId);
      interactionChanged = removed !== undefined && (owner === undefined || owner.eligible === 1);
    } else if (p.type === "background_task.started" && p.task.status === "running") {
      this.statement("INSERT INTO tasks VALUES(?,?) ON CONFLICT(thread,id) DO NOTHING").run(
        event.threadId,
        p.task.id,
      );
    } else if (p.type === "background_task.updated" && p.status !== "running") {
      const removed = this.statement("DELETE FROM tasks WHERE thread=? AND id=? RETURNING id").get(
        event.threadId,
        p.taskId,
      );
      backgroundCompleted = removed !== undefined && p.status === "completed";
    }
    return { interactionChanged, backgroundCompleted };
  }
  first(thread: ThreadId): z.infer<typeof InteractionLink> | undefined {
    const row = this.statement(
      "SELECT interactions.body FROM interaction_owners JOIN interactions USING(thread,id) WHERE thread=? AND eligible=1 ORDER BY interaction_owners.seq LIMIT 1",
    ).get(thread);
    return row ? InteractionLink.parse(JSON.parse(String(row.body))) : undefined;
  }
  eligible(thread: ThreadId, id: string): boolean {
    return (
      this.statement(
        "SELECT interactions.id FROM interaction_owners JOIN interactions USING(thread,id) WHERE thread=? AND id=? AND eligible=1",
      ).get(thread, id) !== undefined
    );
  }
}
