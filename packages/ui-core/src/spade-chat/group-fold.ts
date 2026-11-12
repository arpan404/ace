import { z } from "zod";
import type { SpadeFoldInput } from "./fold.ts";
import { spadeGroupBotShape, type SpadeGroupBot } from "./groups.ts";
import type { SpadeStored } from "./wire.ts";

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
  | { kind: "person"; key: string; text: string }
  | { kind: "member"; key: string; bot: SpadeGroupBot; text: string }
  /** A handoff, a queued ask, one that failed, Stop: a short muted line. */
  | { kind: "line"; key: string; text: string };

export interface SpadeGroupState {
  lastSeq: number;
  loaded: boolean;
  caughtUp: boolean;
  items: SpadeGroupItem[];
  /** Messages sent from here that Spade hasn't stored yet. */
  pending: { key: string; text: string }[];
  /** Asks still open, by ask id, in the order they were made. */
  asks: Map<string, { run: string; to: SpadeGroupBot }>;
  /** The group's state and few words, from the live stream's `status` frames. */
  state: "idle" | "working" | "waiting";
  status: string | undefined;
}

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
  };
}

/** Apply one input (the same inputs a bot's conversation takes). Returns whether it changed. */
export function foldSpadeGroup(state: SpadeGroupState, input: SpadeFoldInput): boolean {
  switch (input.kind) {
    case "stored":
      return foldStored(state, input.stored);
    case "sent":
      state.pending = [...state.pending, { key: input.key, text: input.text }];
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
      if (state.state === input.state && state.status === status) return false;
      state.state = input.state;
      state.status = status;
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
  return foldEvent(state, parsed.data, `s${stored.seq}`) || firstLoad;
}

function foldEvent(state: SpadeGroupState, event: GroupEvent, key: string): boolean {
  switch (event.type) {
    case "group_message": {
      if (event.from) {
        state.items.push({ kind: "member", key, bot: event.from, text: event.text });
        return true;
      }
      const mine = state.pending.findIndex((message) => message.text === event.text);
      if (mine >= 0) state.pending = state.pending.filter((_, index) => index !== mine);
      state.items.push({ kind: "person", key, text: event.text });
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
  | { kind: "person"; key: string; text: string; sending: boolean }
  | {
      kind: "member";
      key: string;
      bot: SpadeGroupBot;
      text: string;
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
}

const sameBot = (a: SpadeGroupBot, b: SpadeGroupBot) =>
  a.id === b.id && (a.machine ?? null) === (b.machine ?? null);

export function spadeGroupView(state: SpadeGroupState): SpadeGroupView {
  const items: SpadeGroupItem[] = [...state.items];
  for (const message of state.pending)
    items.push({ kind: "person", key: message.key, text: message.text });
  const rows = items.map((item, index): SpadeGroupRow => {
    if (item.kind === "person")
      return {
        kind: "person",
        key: item.key,
        text: item.text,
        sending: index >= state.items.length,
      };
    if (item.kind === "line") return item;
    const before = items[index - 1];
    const after = items[index + 1];
    return {
      kind: "member",
      key: item.key,
      bot: item.bot,
      text: item.text,
      first: before?.kind !== "member" || !sameBot(before.bot, item.bot),
      last: after?.kind !== "member" || !sameBot(after.bot, item.bot),
    };
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
  };
}

const waitingWords = / is waiting for you$/;

/**
 * The member that waits for the person, while the group waits: the one its status names
 * (`<Name> is waiting for you`), the latest open ask to it first, else the member of that name.
 * Undefined when the group doesn't wait or names no one this window can match.
 */
export function spadeGroupWaiting(
  view: Pick<SpadeGroupView, "state" | "status" | "asked">,
  members: readonly SpadeGroupBot[],
): SpadeGroupBot | undefined {
  if (view.state !== "waiting" || !view.status || !waitingWords.test(view.status)) return undefined;
  const name = view.status.replace(waitingWords, "");
  return view.asked.findLast((bot) => bot.name === name) ?? members.find((bot) => bot.name === name);
}
