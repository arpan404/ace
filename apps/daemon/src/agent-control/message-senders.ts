import { z } from "zod";
import { ThreadId, type CommandId } from "@ace/protocol";
import type { Store } from "../store.ts";

/** Rows kept; the oldest go first. A notice for a message this old is no longer useful. */
const capacity = 10_000;

/**
 * Which thread sent each agent message, so a message that fails after the tool returned is
 * reported to its sender, whether the target is a delegated child or a thread it started.
 */
export class MessageSenders {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS agent_message_senders (
      command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender_thread TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS agent_message_senders_age ON agent_message_senders(created_at);`),
    );
  }
  /** Records the sender before the message is sent; a retry of the same command keeps the first. */
  record(command: CommandId, thread: ThreadId, sender: ThreadId, at: number) {
    this.store.atomic((db) => {
      db.prepare("INSERT OR IGNORE INTO agent_message_senders VALUES (?,?,?,?)").run(
        command,
        thread,
        sender,
        at,
      );
      db.prepare(
        `DELETE FROM agent_message_senders WHERE command_id IN (SELECT command_id
        FROM agent_message_senders ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
      ).run(capacity);
    });
  }
  /** The thread that sent `command` to `thread`, if an agent did. */
  sender(command: string, thread: ThreadId): ThreadId | undefined {
    const row = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT sender_thread FROM agent_message_senders WHERE command_id=? AND thread_id=?",
        )
        .get(command, thread),
    );
    return row ? z.object({ sender_thread: ThreadId }).parse(row).sender_thread : undefined;
  }
}
