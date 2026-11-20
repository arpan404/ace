import { z } from "zod";
import {
  Addressee,
  AddressedShare,
  AddressedState,
  ContentPart,
  ThreadId,
  type AddressedTo,
} from "@ace/protocol";
import type { Store } from "../store.ts";

/*
 * The addressed messages and their asks (ADR 0194), kept so a restart picks every open ask up
 * again and the person's message keeps saying where each addressee stands. Two small tables of
 * their own, made empty on first use: nothing here grows with the rest of history.
 */

export interface AddressedRow {
  commandId: string;
  threadId: ThreadId;
  input: ContentPart[];
  share: AddressedShare;
}
export interface AskRow {
  key: string;
  commandId: string;
  index: number;
  threadId: ThreadId;
  to: Addressee;
  state: z.infer<typeof AddressedState>;
  detail: string | undefined;
  /** Replies already posted in the thread. */
  posted: number;
  /** Spade took it (`accepted` or `duplicate`). */
  delivered: boolean;
  createdAt: number;
  done: boolean;
}

const MessageRow = z.object({
  command_id: z.string(),
  thread_id: ThreadId,
  input: z.string().transform((text) => z.array(ContentPart).parse(JSON.parse(text))),
  share: AddressedShare,
});
const StoredAsk = z.object({
  key: z.string(),
  command_id: z.string(),
  idx: z.number(),
  thread_id: ThreadId,
  addressee: z.string().transform((text) => Addressee.parse(JSON.parse(text))),
  state: AddressedState,
  detail: z.string().nullable(),
  posted: z.number(),
  delivered: z.number(),
  created_at: z.number(),
  done: z.number(),
});
const toAsk = (row: unknown): AskRow => {
  const ask = StoredAsk.parse(row);
  return {
    key: ask.key,
    commandId: ask.command_id,
    index: ask.idx,
    threadId: ask.thread_id,
    to: ask.addressee,
    state: ask.state,
    detail: ask.detail ?? undefined,
    posted: ask.posted,
    delivered: ask.delivered === 1,
    createdAt: ask.created_at,
    done: ask.done === 1,
  };
};

export class ThreadAskStore {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS thread_addressed (
        command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, input TEXT NOT NULL,
        share TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_asks (
        key TEXT PRIMARY KEY, command_id TEXT NOT NULL, idx INTEGER NOT NULL,
        thread_id TEXT NOT NULL, addressee TEXT NOT NULL, state TEXT NOT NULL, detail TEXT,
        posted INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS thread_asks_open ON thread_asks(done, created_at);
      CREATE INDEX IF NOT EXISTS thread_asks_command ON thread_asks(command_id, idx);`),
    );
  }
  /** Records the message and its asks before anything is sent; a repeat keeps the first. */
  begin(message: AddressedRow, asks: readonly AskRow[], at: number): void {
    this.store.atomic((db) => {
      db.prepare("INSERT OR IGNORE INTO thread_addressed VALUES (?,?,?,?,?)").run(
        message.commandId,
        message.threadId,
        JSON.stringify(message.input),
        message.share,
        at,
      );
      const insert = db.prepare(
        "INSERT OR IGNORE INTO thread_asks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const ask of asks)
        insert.run(
          ask.key,
          ask.commandId,
          ask.index,
          ask.threadId,
          JSON.stringify(ask.to),
          ask.state,
          ask.detail ?? null,
          ask.posted,
          ask.delivered ? 1 : 0,
          at,
          at,
          ask.done ? 1 : 0,
        );
    });
  }
  message(commandId: string): AddressedRow | undefined {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT * FROM thread_addressed WHERE command_id=?").get(commandId),
    );
    if (!row) return undefined;
    const message = MessageRow.parse(row);
    return {
      commandId: message.command_id,
      threadId: message.thread_id,
      input: message.input,
      share: message.share,
    };
  }
  /** Every addressee of one message, in the order the person wrote them. */
  asks(commandId: string): AskRow[] {
    return this.store
      .atomic((db) =>
        db.prepare("SELECT * FROM thread_asks WHERE command_id=? ORDER BY idx").all(commandId),
      )
      .map(toAsk);
  }
  ask(key: string): AskRow | undefined {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT * FROM thread_asks WHERE key=?").get(key),
    );
    return row ? toAsk(row) : undefined;
  }
  /** Asks still waiting for Spade, oldest first: what a restart picks up. */
  open(): AskRow[] {
    return this.store
      .atomic((db) =>
        db.prepare("SELECT * FROM thread_asks WHERE done=0 ORDER BY created_at, key").all(),
      )
      .map(toAsk);
  }
  update(
    key: string,
    change: Partial<Pick<AskRow, "state" | "detail" | "posted" | "delivered" | "done">>,
    at: number,
  ): void {
    const current = this.ask(key);
    if (!current) return;
    const next = { ...current, ...change };
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE thread_asks SET state=?, detail=?, posted=?, delivered=?, done=?, updated_at=? WHERE key=?",
        )
        .run(
          next.state,
          next.detail ?? null,
          next.posted,
          next.delivered ? 1 : 0,
          next.done ? 1 : 0,
          at,
          key,
        ),
    );
  }
}

/** The addressees as the person's message shows them. */
export function addressedOf(asks: readonly AskRow[]): AddressedTo[] {
  return asks.map((ask) => ({
    to: ask.to,
    state: ask.state,
    ...(ask.detail ? { detail: ask.detail } : {}),
  }));
}
