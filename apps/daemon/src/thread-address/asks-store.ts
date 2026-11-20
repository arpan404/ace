import { z } from "zod";
import {
  Addressee,
  AddressedShare,
  AddressedState,
  ContentPart,
  DeviceContextItem,
  ThreadId,
  type AddressedTo,
  type AskedLine,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import { personText } from "./plan.ts";

/*
 * The addressed messages and their asks (ADR 0198), kept so a restart picks every open ask up
 * again and the person's message keeps saying where each addressee stands. Two small tables of
 * their own, made empty on first use: nothing here grows with the rest of history.
 */

export interface AddressedRow {
  commandId: string;
  threadId: ThreadId;
  /** The person's message this is about: its `thread.send`, or the message a follow-up follows. */
  about: string;
  input: ContentPart[];
  share: AddressedShare;
  /** What went with it, in words, for the line. */
  shares: string[];
  /** The context pack as it was when the person sent it; none when only the message went. */
  pack: string | undefined;
  /** A follow-up went to the bots alone: its words are shown on ace's line. */
  followUp: boolean;
  /** Devices the message named, for its chips. */
  devices: DeviceContextItem[];
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
  about: z.string(),
  input: z.string().transform((text) => z.array(ContentPart).parse(JSON.parse(text))),
  share: AddressedShare,
  shares: z.string().transform((text) => z.array(z.string()).parse(JSON.parse(text))),
  pack: z.string().nullable(),
  follow_up: z.number(),
  devices: z.string().transform((text) => z.array(DeviceContextItem).parse(JSON.parse(text))),
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
/** A finished reply's words as kept for the thread's agent. */
export interface SavedReply {
  itemKey: string;
  threadId: ThreadId;
  bot: string;
  club?: string | undefined;
  text: string;
}
const StoredReply = z.object({
  item_key: z.string(),
  thread_id: ThreadId,
  bot: z.string(),
  club: z.string().nullable(),
  text: z.string(),
});
const toReply = (row: unknown): SavedReply => {
  const reply = StoredReply.parse(row);
  return {
    itemKey: reply.item_key,
    threadId: reply.thread_id,
    bot: reply.bot,
    ...(reply.club ? { club: reply.club } : {}),
    text: reply.text,
  };
};
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
        command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, about TEXT NOT NULL,
        input TEXT NOT NULL, share TEXT NOT NULL, shares TEXT NOT NULL, pack TEXT,
        follow_up INTEGER NOT NULL, devices TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_asks (
        key TEXT PRIMARY KEY, command_id TEXT NOT NULL, idx INTEGER NOT NULL,
        thread_id TEXT NOT NULL, addressee TEXT NOT NULL, state TEXT NOT NULL, detail TEXT,
        posted INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS thread_ask_replies (
        item_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot TEXT NOT NULL, club TEXT,
        text TEXT NOT NULL, given INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_ask_replies_given ON thread_ask_replies(thread_id, given);
      CREATE INDEX IF NOT EXISTS thread_asks_open ON thread_asks(done, created_at);
      CREATE INDEX IF NOT EXISTS thread_asks_command ON thread_asks(command_id, idx);`),
    );
  }
  /** Records the message and its asks before anything is sent; a repeat keeps the first. */
  begin(message: AddressedRow, asks: readonly AskRow[], at: number): void {
    this.store.atomic((db) => {
      db.prepare("INSERT OR IGNORE INTO thread_addressed VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        message.commandId,
        message.threadId,
        message.about,
        JSON.stringify(message.input),
        message.share,
        JSON.stringify(message.shares),
        message.pack ?? null,
        message.followUp ? 1 : 0,
        JSON.stringify(message.devices),
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
      about: message.about,
      input: message.input,
      share: message.share,
      shares: message.shares,
      pack: message.pack ?? undefined,
      followUp: message.follow_up === 1,
      devices: message.devices,
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
  /** Keeps a finished reply's words, for the agent to be given with the person's next message. */
  saveReply(reply: SavedReply, at: number): void {
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR IGNORE INTO thread_ask_replies VALUES (?,?,?,?,?,0,?)")
        .run(reply.itemKey, reply.threadId, reply.bot, reply.club ?? null, reply.text, at),
    );
  }
  /**
   * The replies in a thread its agent hasn't been given, oldest first, marked given: each reaches
   * the agent once, with the person's next message. At most the newest 32.
   */
  takeUngiven(threadId: ThreadId): SavedReply[] {
    return this.store.atomic((db) => {
      const rows = db
        .prepare(
          "SELECT * FROM thread_ask_replies WHERE thread_id=? AND given=0 ORDER BY created_at, item_key",
        )
        .all(threadId)
        .map((row) => toReply(row));
      db.prepare("UPDATE thread_ask_replies SET given=1 WHERE thread_id=? AND given=0").run(
        threadId,
      );
      return rows.slice(-32);
    });
  }
  /** The kept replies by item key, in the order asked; unknown keys are left out. */
  replies(threadId: ThreadId, keys: readonly string[]): SavedReply[] {
    return keys.flatMap((key) => {
      const row = this.store.atomic((db) =>
        db
          .prepare("SELECT * FROM thread_ask_replies WHERE item_key=? AND thread_id=?")
          .get(key, threadId),
      );
      return row ? [toReply(row)] : [];
    });
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

/** ace's line for one addressed message, as it stands. */
export function askedLineOf(message: AddressedRow, asks: readonly AskRow[]): AskedLine {
  return {
    about: message.about,
    to: addressedOf(asks),
    devices: message.devices,
    share: message.share,
    shares: message.shares,
    ...(message.followUp ? { words: personText(message.input) } : {}),
  };
}

/** The addressees as ace's line shows them. */
export function addressedOf(asks: readonly AskRow[]): AddressedTo[] {
  return asks.map((ask) => ({
    to: ask.to,
    state: ask.state,
    ...(ask.detail ? { detail: ask.detail } : {}),
  }));
}
