import { z } from "zod";
import type { SpadeFoldInput } from "./fold.ts";
import { spadeGroupBotShape, type SpadeGroupBot } from "./groups.ts";
import type { SpadeStored } from "./wire.ts";
import { spadeChatSegments, spadeMessageId } from "./chat-markup.ts";
import { spadeDocCard, spadeLongWords, type SpadeDocCard } from "./documents-in-chat.ts";
import {
  spadeQuoteOf,
  spadeReplyToField,
  spadeSaid,
  type SpadeQuote,
  type SpadeReplyTo,
} from "./replies.ts";

/*
 * A group's conversation as the person sees it (ADR 0132, spade/docs/teams.md "Group events"):
 * the person's messages and each member's answer as bubbles, a handoff between members as one
 * short line, a queued, failed or stopped ask as one short line. Nothing of how a bot works
 * shows. Pure, like `foldSpade`: each input does work in proportion to itself.
 */

const run = z.string().catch("");
const ask = z.string().catch("");
const groupEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("group_message"),
    run,
    text: z.string().catch(""),
    from: spadeGroupBotShape.nullish().catch(undefined),
    /** The person wrote it in an ace thread (ADR 0198). */
    thread: z
      .object({
        id: z.string().min(1),
        title: z.string().catch(""),
        /** The person's other machine the thread is on; absent for this machine's. */
        machine: z.string().max(256).optional().catch(undefined),
      })
      .nullish()
      .catch(undefined),
    /** The message the person's replies to, as Spade stored it (ADR 0212 §4). */
    reply_to: spadeReplyToField,
  }),
  z.object({
    type: z.literal("group_asked"),
    run,
    ask,
    by: spadeGroupBotShape.nullish().catch(undefined),
    to: spadeGroupBotShape,
  }),
  z.object({
    type: z.literal("group_answered"),
    run,
    ask,
    to: spadeGroupBotShape,
    outcome: z.string().catch("answered"),
    detail: z.string().nullish().catch(undefined),
  }),
  z.object({
    type: z.literal("group_queued"),
    run,
    ask,
    to: spadeGroupBotShape,
    machine_name: z.string().catch(""),
  }),
  z.object({ type: z.literal("group_stopped"), run }),
]);
type GroupEvent = z.infer<typeof groupEvent>;

export type SpadeGroupItem =
  | {
      kind: "person";
      key: string;
      text: string;
      fromThread?: { id: string; title: string; machine?: string | undefined } | undefined;
      /** Its message id, once stored (ADR 0212 §3). */
      id?: string;
      replyTo?: SpadeReplyTo | undefined;
    }
  /** `seq`: the stored event, which names the messages its words hold (ADR 0212 §3). */
  | { kind: "member"; key: string; bot: SpadeGroupBot; text: string; seq?: number }
  /** A handoff, a queued ask, one that failed, Stop: a short muted line. */
  | { kind: "line"; key: string; text: string };

export interface SpadeGroupState {
  lastSeq: number;
  loaded: boolean;
  caughtUp: boolean;
  items: SpadeGroupItem[];
  /** Messages sent from here that Spade hasn't stored yet. */
  pending: { key: string; text: string; replyTo?: SpadeReplyTo | undefined }[];
  /** Asks still open, by ask id, in the order they were made. */
  asks: Map<string, { run: string; to: SpadeGroupBot }>;
  /** The group's state and few words, from the live stream's `status` frames. */
  state: "idle" | "working" | "waiting";
  status: string | undefined;
  /** The member the server says waits for the person, while the group waits. */
  waitingMember: SpadeGroupBot | undefined;
  /** A `status` frame has come: `state` is the stream's word, not the empty default. */
  reported: boolean;
}

const sameBot = (a: SpadeGroupBot, b: SpadeGroupBot) =>
  a.id === b.id && (a.machine ?? null) === (b.machine ?? null);

export function emptySpadeGroup(): SpadeGroupState {
  return {
    lastSeq: 0,
    loaded: false,
    caughtUp: false,
    items: [],
    pending: [],
    asks: new Map(),
    state: "idle",
    status: undefined,
    waitingMember: undefined,
    reported: false,
  };
}

/** Apply one input (the same inputs a bot's conversation takes). Returns whether it changed. */
export function foldSpadeGroup(state: SpadeGroupState, input: SpadeFoldInput): boolean {
  switch (input.kind) {
    case "stored":
      return foldStored(state, input.stored);
    case "sent":
      state.pending = [
        ...state.pending,
        { key: input.key, text: input.text, ...(input.replyTo ? { replyTo: input.replyTo } : {}) },
      ];
      return true;
    case "refused": {
      const before = state.pending.length;
      state.pending = state.pending.filter((message) => message.key !== input.key);
      return state.pending.length !== before;
    }
    case "caught_up": {
      const changed = !state.caughtUp || !state.loaded;
      state.caughtUp = true;
      state.loaded = true;
      return changed;
    }
    case "status": {
      const status = input.state === "idle" ? undefined : input.status;
      const waiting = input.state === "waiting" ? input.waitingMember : undefined;
      const sameWaiting =
        state.waitingMember === waiting ||
        (state.waitingMember !== undefined &&
          waiting !== undefined &&
          sameBot(state.waitingMember, waiting));
      // A group never sleeps itself; a stream that says so reads as at work, as older clients do.
      // Nor is it paused: only bots are (ADR 0200 §6.1), so one that says so reads at rest; nor
      // updated, so one that says so reads at work.
      const next =
        input.state === "sleeping" || input.state === "updating"
          ? "working"
          : input.state === "paused"
            ? "idle"
            : input.state;
      const first = !state.reported;
      state.reported = true;
      if (state.state === next && state.status === status && sameWaiting) return first;
      state.state = next;
      state.status = status;
      state.waitingMember = waiting;
      return true;
    }
    // A group has no streamed words: each answer arrives whole, as the member's message.
    case "snapshot":
    case "delta":
      return false;
  }
}

function foldStored(state: SpadeGroupState, stored: SpadeStored): boolean {
  if (stored.seq <= state.lastSeq) return false;
  state.lastSeq = stored.seq;
  const firstLoad = !state.loaded;
  state.loaded = true;
  // Group events are no bot conversation's, so the shared parser keeps them as raw data.
  const raw = stored.event.type === "unknown" ? stored.event.raw : undefined;
  const parsed = groupEvent.safeParse(raw);
  if (!parsed.success) return firstLoad;
  return foldEvent(state, parsed.data, stored.seq) || firstLoad;
}

function foldEvent(state: SpadeGroupState, event: GroupEvent, seq: number): boolean {
  const key = `s${seq}`;
  switch (event.type) {
    case "group_message": {
      if (event.from) {
        state.items.push({ kind: "member", key, bot: event.from, text: event.text, seq });
        return true;
      }
      const mine = state.pending.findIndex((message) => message.text === event.text);
      if (mine >= 0) state.pending = state.pending.filter((_, index) => index !== mine);
      state.items.push({
        kind: "person",
        key,
        text: event.text,
        id: spadeMessageId(seq),
        ...(event.reply_to ? { replyTo: event.reply_to } : {}),
        ...(event.thread
          ? {
              fromThread: {
                id: event.thread.id,
                title: event.thread.title,
                ...(event.thread.machine ? { machine: event.thread.machine } : {}),
              },
            }
          : {}),
      });
      return true;
    }
    case "group_asked":
      state.asks.set(event.ask, { run: event.run, to: event.to });
      // The person's own message is its bubble; only a member's handoff reads as a line.
      if (event.by)
        state.items.push({ kind: "line", key, text: `${event.by.name} asked ${event.to.name}` });
      return true;
    case "group_answered": {
      state.asks.delete(event.ask);
      const text = answeredLine(event.to.name, event.outcome, event.detail ?? undefined);
      if (text) state.items.push({ kind: "line", key, text });
      return true;
    }
    case "group_queued":
      state.items.push({
        kind: "line",
        key,
        text: `Waiting for ${event.machine_name || "its machine"} to come online`,
      });
      return true;
    case "group_stopped":
      for (const [id, open] of state.asks) if (open.run === event.run) state.asks.delete(id);
      state.items.push({ kind: "line", key, text: "Stopped" });
      return true;
  }
}

/**
 * How an ask ended, when it didn't end in an answer. A stopped ask says nothing of its own:
 * Stop's one line says it for the whole run.
 */
function answeredLine(name: string, outcome: string, detail: string | undefined) {
  const why = detail ? `: ${detail}` : "";
  switch (outcome) {
    case "answered":
    case "stopped":
      return undefined;
    case "refused":
      return `${name} couldn't take it${why}`;
    case "gave_up":
      return `${name}'s machine didn't come back online`;
    default:
      return `${name} couldn't answer${why}`;
  }
}

/** One row of a group's chat; a member's carries where it sits in its run of messages. */
export type SpadeGroupRow =
  | {
      kind: "person";
      key: string;
      text: string;
      sending: boolean;
      /** Written in an ace thread (ADR 0198): the line above links back to it. */
      fromThread?: { id: string; title: string; machine?: string | undefined } | undefined;
      /** Its message id, once stored: what Reply quotes (ADR 0212). */
      id?: string;
      /** The message it replies to. */
      quote?: SpadeQuote;
    }
  | {
      kind: "member";
      key: string;
      bot: SpadeGroupBot;
      text: string;
      id?: string;
      quote?: SpadeQuote;
      /** Long words as a document card (ADR 0212 §5). */
      doc?: SpadeDocCard;
      /** First of a run of consecutive messages from this bot: its name shows above. */
      first: boolean;
      /** Last of the run: its face shows beside. */
      last: boolean;
    }
  | { kind: "line"; key: string; text: string };

export interface SpadeGroupView {
  loaded: boolean;
  rows: SpadeGroupRow[];
  /** Anything is open: an ask, or the group says it isn't idle. Stop is offered then. */
  busy: boolean;
  state: "idle" | "working" | "waiting";
  status: string | undefined;
  /** The member answering now: the latest open ask's. */
  working: SpadeGroupBot | undefined;
  /** Who each open ask went to, oldest first. */
  asked: SpadeGroupBot[];
  /** The member that waits for the person, as the server named it. */
  waitingMember: SpadeGroupBot | undefined;
  /** Caught up and told the group's state by its live stream: `state` is the stream's word. */
  live: boolean;
}

export function spadeGroupView(state: SpadeGroupState): SpadeGroupView {
  const said = spadeSaid();
  // Each member's words as the messages they hold (ADR 0212 §2), one row each.
  const flat: (
    | SpadeGroupRow
    | Omit<Extract<SpadeGroupRow, { kind: "member" }>, "first" | "last">
  )[] = [];
  state.items.forEach((item) => {
    if (item.kind === "line") return flat.push(item);
    if (item.kind === "person") {
      if (item.id) said.add(item.id, item.text, { kind: "person" });
      return flat.push(personRow(item, false));
    }
    spadeChatSegments(item.text).forEach((segment, index) => {
      const id = item.seq === undefined ? undefined : spadeMessageId(item.seq, index);
      const quote = segment.reply === undefined ? undefined : said.quote(segment.reply);
      const long = segment.kind === "msg" ? spadeLongWords(segment.text) : undefined;
      const doc = segment.kind === "doc" ? spadeDocCard(segment.title, segment.text) : long?.doc;
      flat.push({
        kind: "member",
        key: index ? `${item.key}:${index + 1}` : item.key,
        bot: item.bot,
        text: segment.kind === "doc" ? "" : (long?.summary ?? segment.text),
        ...(id ? { id } : {}),
        ...(quote ? { quote } : {}),
        ...(doc ? { doc } : {}),
      });
      if (id) said.add(id, segment.title ?? segment.text, { kind: "member", name: item.bot.name });
    });
  });
  for (const message of state.pending)
    flat.push(
      personRow(
        { kind: "person", key: message.key, text: message.text, replyTo: message.replyTo },
        true,
      ),
    );
  const rows = flat.map((row, index): SpadeGroupRow => {
    if (row.kind !== "member") return row;
    const before = flat[index - 1];
    const after = flat[index + 1];
    // Each row is this view's own: where it sits in its run is set in place.
    return Object.assign(row, {
      first: before?.kind !== "member" || !sameBot(before.bot, row.bot),
      last: after?.kind !== "member" || !sameBot(after.bot, row.bot),
    });
  });
  const asked = Array.from(state.asks.values(), (open) => open.to);
  return {
    loaded: state.loaded,
    rows,
    busy: state.state !== "idle" || state.asks.size > 0,
    state: state.state,
    status: state.status,
    working: asked.at(-1),
    asked,
    waitingMember: state.waitingMember,
    live: state.caughtUp && state.reported,
  };
}

/**
 * The member that waits for the person, while the group waits: the one the server names in its
 * status (`waiting_member`), as this window knows it among the members (else as named). Never
 * read from the status words.
 */
export function spadeGroupWaiting(
  view: Pick<SpadeGroupView, "state" | "waitingMember">,
  members: readonly SpadeGroupBot[],
): SpadeGroupBot | undefined {
  const waiting = view.waitingMember;
  if (view.state !== "waiting" || !waiting) return undefined;
  return members.find((bot) => sameBot(bot, waiting)) ?? waiting;
}

/** The person's message as its row: sent or still going, quoting what it replies to. */
function personRow(
  item: Extract<SpadeGroupItem, { kind: "person" }>,
  sending: boolean,
): Extract<SpadeGroupRow, { kind: "person" }> {
  const row: Extract<SpadeGroupRow, { kind: "person" }> = {
    kind: "person",
    key: item.key,
    text: item.text,
    sending,
  };
  if (item.fromThread) row.fromThread = item.fromThread;
  if (item.id) row.id = item.id;
  if (item.replyTo) row.quote = spadeQuoteOf(item.replyTo);
  return row;
}
