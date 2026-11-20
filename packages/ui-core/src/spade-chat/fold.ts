import { spadeRemembered, type SpadeRememberedNote } from "./notes.ts";
import { spadeNeedsSearchSetup } from "./web-search.ts";
import type { SpadeDocumentRef, SpadeImageRef, SpadeVoiceRef } from "./media.ts";
import type {
  SpadeFailureKind,
  SpadeKnownEvent,
  SpadeLiveInput,
  SpadeStored,
  SpadeStoppedKind,
} from "./wire.ts";
import { spadeHelperTask, spadeHelperTool } from "./helper-words.ts";
import {
  spadeCardQuestions,
  spadeConnectOf,
  type SpadeQuestion,
  type SpadeQuestionStanding,
} from "./questions.ts";
import {
  emptySpadeCapabilities,
  foldSpadeCapability,
  type SpadeCapabilityState,
} from "./fold-capabilities.ts";
import type { SpadeQuiet } from "./quiet.ts";
import { parseSpadeDecision, type SpadeDecision } from "./decisions.ts";
import { spadeRiskWeight, spadeStepFacts, type SpadeStepWeight } from "./step-facts.ts";
import type { SpadeRefusedHost } from "./wire.ts";

/** A background job: the tool it runs and, for a delegation, how many tasks it handed out. */
export interface SpadeJob {
  name: string;
  agents: number | undefined;
  /** The reply that started it, whose Stop also stops it. */
  reply: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * How many tasks a delegation's call handed out, from its arguments (`{tasks: [...]}`, or the
 * same inside `call_tool`'s `{name, arguments}`); undefined when they don't say.
 */
function delegatedTasks(argumentsValue: unknown): number | undefined {
  const outer = record(argumentsValue);
  const inner = record(outer?.arguments) ?? outer;
  const tasks = inner?.tasks;
  return Array.isArray(tasks) && tasks.length > 0 ? tasks.length : undefined;
}

/*
 * A Spade conversation as the person sees it, folded from its stored events and live frames
 * (spade/docs/chat-core.md, harness.md). Pure: no I/O, no clock. Each input does work in
 * proportion to itself: entries are replaced one at a time, never rebuilt from history.
 */

/** How one tool call stands. */
export type SpadeCallState =
  | "queued"
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "declined"
  /** The reply ended before the call had a result. */
  | "skipped"
  /** The auto-review refused it (ADR 0163): it never ran, and the bot was told why. */
  | "refused";

export type SpadeReplyPart =
  | { kind: "text"; key: string; text: string }
  | {
      kind: "call";
      key: string;
      name: string;
      state: SpadeCallState;
      /**
       * The `seq` of the event Spade's activity log files this call under: its `tool_started`,
       * else the `tool_finished` of a call that never started. Joins it to its sentence and
       * detail there.
       */
      logged?: number;
      /** Why the auto-review refused it, when it did. */
      reason?: string;
      /** One line of what it touched: its command, a file's path, a page's address. */
      detail?: string;
      /** It deletes or can't be undone, or acts outside the bot (`spadeStepFacts`). */
      weight?: SpadeStepWeight;
      /** Where a command ran and how it went, once Spade says (`command_ran`). */
      ran?: SpadeCommandRan;
      /**
       * What the tool declared it does, as Spade's gate read it (`send_as_person`, `pay`,
       * `publish`, `change_access`, `network`…), from its `tool_started`.
       */
      effect?: string;
    }
  /** A note the bot saved or rewrote with its memory tools (ADR 0128). */
  | { kind: "remembered"; key: string; note: SpadeRememberedNote }
  /** The bot asked the person a card of questions (`ask_user`, ADR 0154), where it asked. */
  | ({ kind: "question"; key: string } & SpadeQuestionCard)
  /** `web_search` had nothing set up to search with: a line that opens its setting. */
  | { kind: "search-setup"; key: string }
  /** Workspace files a tool kept (a research report): chips on the bot's next bubble. */
  | { kind: "files"; key: string; paths: readonly string[] }
  /** A call that asked the person, where it asked, with how they answered (`SpadeRequest`). */
  | ({ kind: "request"; key: string } & SpadeRequest)
  /** Images and documents a tool showed the person (`image_generate`, `share_file`; ADR 0134). */
  | {
      kind: "shared";
      key: string;
      images: readonly SpadeImageRef[];
      documents: readonly SpadeDocumentRef[];
    };

/** Where a command ran and how it went (`command_ran`). */
export interface SpadeCommandRan {
  /** Spade's sandbox held it; undefined when Spade's word on it couldn't be read. */
  contained: boolean | undefined;
  /** Undefined when a signal ended it. */
  exitCode: number | undefined;
  timedOut: boolean;
  /** Hosts it reached through Spade's proxy. */
  reached: readonly string[];
  /** Hosts its network policy refused it, with why. */
  refused: readonly SpadeRefusedHost[];
}

export type SpadeReplyEnd =
  | { kind: "finished" }
  | { kind: "stopped" }
  | {
      kind: "failed";
      /** What went wrong as the endpoint or Spade said it: for the activity log and Details. */
      error: string;
      failure: SpadeFailureKind;
      /** The endpoint's id, when the endpoint was to blame. */
      endpoint: string | undefined;
    }
  | { kind: "interrupted" };

export interface SpadeReplyEntry {
  kind: "reply";
  key: string;
  /**
   * The reply's id. Every step event names it, so a step lands under its own reply whatever
   * arrived in between. The parts of a reply the person steered share it.
   */
  reply: string;
  /** Each model step's words and calls, in order. */
  parts: readonly SpadeReplyPart[];
  /** The open step's words so far: checkpoints, then live pieces. Empty once it is stored. */
  live: string;
  /** Undefined while the reply is open. */
  end: SpadeReplyEnd | undefined;
  startedAt: number;
}

export type SpadeEntry =
  | { kind: "task-paused"; key: string; reason: "budget" | "no_progress"; steps: number }
  | {
      kind: "user";
      key: string;
      text: string;
      images: readonly SpadeImageRef[];
      /** Present only when the message carries any. */
      documents?: readonly SpadeDocumentRef[];
      /** A voice message's recording; `text` is its transcript. */
      voice?: SpadeVoiceRef;
      pending?: true;
      /** Sent by another bot, not the person. */
      fromAgent?: { id: string; name: string };
      /** Fired by one of the bot's routines or its heartbeat, not the person. */
      fromRoutine?: { id: string; name: string; label: string; heartbeat: boolean };
      /** Sent here from a group the bot is in (ADR 0132). */
      fromGroup?: { id: string; name: string };
      /** Written by the person in an ace thread (ADR 0198). */
      fromThread?: { id: string; title: string };
      /** When Spade stored it; a message not stored yet has none. */
      at?: number;
      /** The notes Spade recalled for it, by id: what the reply to it had in mind (ADR 0128). */
      recalled?: readonly string[];
    }
  | SpadeReplyEntry
  /** The model now reads a summary of what came before. */
  | { kind: "compacted"; key: string }
  /** The bot rewrote its own task (`task_update`): what it was, what it is, and its one line. */
  | { kind: "task-changed"; key: string; task: string; previous: string; why: string; at?: number }
  /** It made a standing bot for the person: one line with Open and Undo. */
  | { kind: "made"; key: string; bot: string; name: string; task: string; at?: number }
  /** It added a bot to a club it is in. */
  | {
      kind: "club-added";
      key: string;
      club: string;
      clubName: string;
      bot: string;
      botName: string;
      at?: number;
    }
  /** The bot named itself or changed its face; `first` when it was its first name. */
  | { kind: "named"; key: string; name: string; face: boolean; first: boolean; at?: number }
  /** A background job ended; its result went to Spade. */
  | {
      kind: "job";
      key: string;
      name: string;
      outcome: SpadeJobOutcome;
      /** Workspace files it kept, for chips on the bot's next bubble. */
      files: readonly string[];
    }
  /**
   * A helper the bot started (ADR 0152): one line where it started, updated in place as it
   * works and ends. `result` is what it handed back, once it has.
   */
  | {
      kind: "helper";
      key: string;
      job: string;
      task: string;
      outcome: SpadeJobOutcome | undefined;
      result: string;
      at?: number;
    }
  /** The person handed the computer back: Spade's narration, and the names as plain data. */
  | { kind: "handback"; key: string; text: string; data: readonly string[] }
  /** A card asked outside the open reply: where it arrived. */
  | ({ kind: "question"; key: string; at?: number } & SpadeQuestionCard)
  /**
   * A request asked outside the open reply (a helper's, or one asked after its reply ended):
   * where it arrived, read below the bot's words so far.
   */
  | ({ kind: "request"; key: string; at?: number } & SpadeRequest)
  /** An event that is nobody's words, as one quiet line where it happened (`spadeQuietLine`). */
  | { kind: "quiet"; key: string; quiet: SpadeQuiet; at?: number };

/**
 * A call that asked the person, kept where it asked so its bubble stays in place once answered.
 * `answer` is undefined until they answered; a request whose reply ended unanswered stays so.
 */
/** A card of questions, kept where it was asked, with how it stands now. */
export interface SpadeQuestionCard {
  callId: string;
  questions: readonly SpadeQuestion[];
  standing: SpadeQuestionStanding;
  /** One per question once answered in the card, or by a message that could stand for them. */
  answers: readonly unknown[] | undefined;
  /** A message the person typed answered it (with `answers` when it could stand for them). */
  typed: boolean;
  /** The bot asked it without waiting: for later from the start. */
  askedForLater: boolean;
}

export type SpadeAskKind = "undeclared" | "outside_sandbox" | "drive";

/** Whether the person's answer to a request `stopped` asked holds for that call only. */
export const spadeAnsweredOnce = (stopped: SpadeStoppedKind | undefined): boolean =>
  stopped === "incomplete" || stopped === "unread" || stopped === "changed";

export interface SpadeRequest {
  callId: string;
  name: string;
  arguments: unknown;
  reason: string | undefined;
  /**
   * Why Spade asked (ADR 0171): a tool with no declared effect, a command outside the sandbox, or
   * a step that acts in a page or app.
   */
  ask?: SpadeAskKind;
  /** Which of Spade's judges put it to the person, when one did. */
  stopped?: SpadeStoppedKind;
  /** For a driving step, the app or site its "always" allows for the bot. */
  app?: string;
  helper?: { job: string; task: string };
  answer: "allowed" | "denied" | undefined;
  /** Allowed always. */
  always: boolean;
}

/** How a background job ended: on its own, with an error, or because the person pressed Stop. */
export type SpadeJobOutcome = "done" | "failed" | "stopped";

export interface SpadeApproval {
  reply: string;
  callId: string;
  name: string;
  arguments: unknown;
  /** Why the model review asked the person rather than let it run (ADR 0135). */
  reason: string | undefined;
  ask?: SpadeAskKind;
  stopped?: SpadeStoppedKind;
  app?: string;
  /** A helper's call (ADR 0152): its job and task. It outlives the reply that started it. */
  helper?: { job: string; task: string };
}

/**
 * A plugin's server or hook asking to run outside the sandbox (ADR 0167): open until the person
 * answers. Not part of any reply: the plugin simply doesn't start until then.
 */
export interface SpadeOutsideAsk {
  id: string;
  plugin: string;
  version: string;
  /** What would run: `server <name>` or `hook <event>`. */
  what: string;
  /** The request's sentence, in Spade's words. */
  line: string;
}

export interface SpadeConversationState {
  /** The highest `seq` folded; a stored event at or below it is a duplicate. */
  lastSeq: number;
  /** At least one stored event has arrived. */
  loaded: boolean;
  /** The live stream has sent everything stored so far; later events are new. */
  caughtUp: boolean;
  title: string;
  entries: SpadeEntry[];
  /** Messages sent from here that Spade hasn't stored yet. */
  pending: SpadePendingMessage[];
  /** The open reply's id and its entry's index. */
  open: { reply: string; index: number } | undefined;
  /** Where each call of the open reply is shown: its entry's index. */
  calls: Map<string, { reply: string; index: number; arguments?: unknown }>;
  /** Running tool calls by call id. */
  running: Map<string, { reply: string; name: string }>;
  approvals: SpadeApproval[];
  /** Plugins asking to run outside the sandbox, oldest first, until the person answers. */
  outsideAsks: SpadeOutsideAsk[];
  /** The open reply's card waiting on the person: answered in it or by their next message. */
  question: { reply: string; callId: string } | undefined;
  /** Cards left for later and not yet answered or dismissed, by call id, oldest first. */
  forLater: Set<string>;
  /** Background jobs still running, by job id (the id of the call that started each). */
  jobs: Map<string, SpadeJob>;
  /** Jobs a Stop asked to end: their errored end reads as stopped, not failed. */
  stopping: Set<string>;
  /** Stored events of types this client doesn't read, kept count of and otherwise ignored. */
  unknown: number;
  /** Choices the bot made on the person's behalf (ADR 0165), oldest first. */
  decisions: readonly SpadeDecision[];
  /** Why the model review escalated each call, by call id, until its approval is answered. */
  reviews: Map<string, string>;
  /** What the agent last said it does now, from the live stream; cleared once it is idle. */
  status: string | undefined;
  /**
   * The live stream's last `status` frame: the agent's state by Spade's roster rules, workers and
   * wakes included, and the last `seq` folded when it came. It speaks for the events before it.
   */
  reported: SpadeReported | undefined;
  /** How long the open reply has waited on the person (a card, an approval), in ms. */
  waited: number;
  /** When the open reply began its current wait on the person; undefined while it doesn't wait. */
  waitingSince: number | undefined;
  /** Open wakes and the names their words use (ADR 0160, 0161). */
  capabilities: SpadeCapabilityState;
}

/** What a `status` frame said, and the last `seq` folded when it came. */
export interface SpadeReported {
  state: "idle" | "working" | "waiting" | "sleeping";
  status: string | undefined;
  seq: number;
}

/** A message sent from here that Spade hasn't stored yet, as the person sent it. */
export interface SpadePendingMessage {
  key: string;
  text: string;
  images: readonly SpadeImageRef[];
  documents?: readonly SpadeDocumentRef[];
  voice?: SpadeVoiceRef;
}

export type SpadeFoldInput =
  | SpadeLiveInput
  /** The person sent `text`; it shows at once and stays until Spade stores it or refuses it. */
  | {
      kind: "sent";
      key: string;
      text: string;
      images?: readonly SpadeImageRef[];
      documents?: readonly SpadeDocumentRef[];
      voice?: SpadeVoiceRef;
    }
  | { kind: "refused"; key: string };

export function emptySpadeConversation(): SpadeConversationState {
  return {
    lastSeq: 0,
    loaded: false,
    caughtUp: false,
    title: "",
    entries: [],
    pending: [],
    open: undefined,
    calls: new Map(),
    running: new Map(),
    approvals: [],
    outsideAsks: [],
    question: undefined,
    forLater: new Set(),
    jobs: new Map(),
    stopping: new Set(),
    unknown: 0,
    decisions: [],
    reviews: new Map(),
    status: undefined,
    reported: undefined,
    waited: 0,
    waitingSince: undefined,
    capabilities: emptySpadeCapabilities(),
  };
}

/** Apply one input. Returns whether anything the person sees changed. */
export function foldSpade(state: SpadeConversationState, input: SpadeFoldInput): boolean {
  switch (input.kind) {
    case "stored":
      return foldStored(state, input.stored);
    case "snapshot":
      return updateOpen(state, input.reply, (entry) =>
        entry.live === input.text ? undefined : { ...entry, live: input.text },
      );
    case "delta":
      return updateOpen(state, input.reply, (entry) =>
        input.text ? { ...entry, live: entry.live + input.text } : undefined,
      );
    case "sent":
      state.pending = [
        ...state.pending,
        {
          key: input.key,
          text: input.text,
          images: input.images ?? [],
          ...(input.documents?.length ? { documents: input.documents } : {}),
          ...(input.voice ? { voice: input.voice } : {}),
        },
      ];
      return true;
    case "caught_up": {
      const changed = !state.caughtUp || !state.loaded;
      state.caughtUp = true;
      state.loaded = true;
      return changed;
    }
    case "status": {
      const before = state.reported;
      state.reported = { state: input.state, status: input.status, seq: state.lastSeq };
      const reported =
        before?.state !== input.state ||
        before.status !== input.status ||
        before.seq !== state.lastSeq;
      // Asleep, its words are the resting line's, from its wakes.
      const status =
        input.state === "idle" || input.state === "sleeping" ? undefined : input.status;
      if (state.status === status) return reported;
      state.status = status;
      return true;
    }
    case "refused": {
      const before = state.pending.length;
      state.pending = state.pending.filter((message) => message.key !== input.key);
      return state.pending.length !== before;
    }
  }
}

function foldStored(state: SpadeConversationState, stored: SpadeStored): boolean {
  if (stored.seq <= state.lastSeq) return false;
  state.lastSeq = stored.seq;
  const firstLoad = !state.loaded;
  state.loaded = true;
  const { event } = stored;
  if (event.type === "unknown") {
    const decision = parseSpadeDecision(event.raw, stored.at);
    if (decision) {
      state.decisions = [...state.decisions, decision];
      return true;
    }
    state.unknown++;
    return firstLoad;
  }
  const changed = foldKnown(state, event, stored);
  countWaiting(state, stored.at);
  return changed || firstLoad;
}

/**
 * The open reply's time waiting on the person, as its chat shows the wait (a card or an
 * approval open): counted from the event that began it to the one that ended it, so the working
 * line's clock counts only the bot's own work.
 */
function countWaiting(state: SpadeConversationState, at: number) {
  const waiting =
    state.open !== undefined && (state.question !== undefined || state.approvals.length > 0);
  if (waiting && state.waitingSince === undefined) state.waitingSince = at;
  else if (!waiting && state.waitingSince !== undefined) {
    state.waited += Math.max(0, at - state.waitingSince);
    state.waitingSince = undefined;
  }
}

function foldKnown(state: SpadeConversationState, event: SpadeKnownEvent, stored: SpadeStored) {
  const key = `s${stored.seq}`;
  const capability = foldSpadeCapability(state.capabilities, event, (quiet) =>
    steer(state, { kind: "quiet", key, quiet, ...stamp(stored) }),
  );
  if (capability !== undefined) return capability;
  switch (event.type) {
    case "user_message": {
      const mine = state.pending.findIndex((message) => sameMessage(message, event));
      const relayed = event.from_agent || event.from_routine || event.from_group;
      if (mine >= 0 && !relayed) state.pending = state.pending.filter((_, index) => index !== mine);
      // The person's message here answers the bot's waiting card; another bot's, or a group's,
      // doesn't. The card says so; `question_answered {typed}` may follow with what it stood for.
      if (!event.from_agent && !event.from_group && state.question) {
        const { callId } = state.question;
        updateQuestion(state, callId, (card) => ({ ...card, standing: "answered", typed: true }));
        state.question = undefined;
      }
      steer(state, {
        kind: "user",
        key,
        text: event.text,
        images: event.images,
        ...(event.documents.length ? { documents: event.documents } : {}),
        ...(event.voice ? { voice: event.voice } : {}),
        ...(event.from_agent
          ? { fromAgent: { id: event.from_agent.id, name: event.from_agent.name } }
          : {}),
        ...(event.from_routine ? { fromRoutine: event.from_routine } : {}),
        ...(event.from_group
          ? { fromGroup: { id: event.from_group.id, name: event.from_group.name } }
          : {}),
        ...(event.from_thread
          ? { fromThread: { id: event.from_thread.id, title: event.from_thread.title } }
          : {}),
        ...recalledOf(event.context),
        ...stamp(stored),
      });
      return true;
    }
    case "reply_started":
      // At most one reply is open; a new one means the last closed without our seeing it.
      if (state.open) closeOpen(state, { kind: "interrupted" }, "");
      state.entries.push({
        kind: "reply",
        key: event.reply,
        reply: event.reply,
        parts: [],
        live: "",
        end: undefined,
        startedAt: stored.at,
      });
      state.open = { reply: event.reply, index: state.entries.length - 1 };
      state.waited = 0;
      state.waitingSince = undefined;
      return true;
    case "reply_progress":
      // A checkpoint is never newer than the live pieces that already extend it.
      return updateOpen(state, event.reply, (entry) =>
        entry.live.startsWith(event.text) ? undefined : { ...entry, live: event.text },
      );
    case "step_finished": {
      const index = replyAt(state, event.reply);
      if (index !== undefined)
        for (const call of event.calls)
          state.calls.set(call.id, { reply: event.reply, index, arguments: call.arguments });
      return updateReply(state, event.reply, (entry) => ({
        ...entry,
        live: "",
        parts: [
          ...entry.parts,
          ...(event.text.trim() ? [{ kind: "text" as const, key, text: event.text }] : []),
          ...event.calls.map((call) => {
            const { detail, weight } = spadeStepFacts(call.name, call.arguments);
            return {
              kind: "call" as const,
              key: call.id,
              name: call.name,
              state: "queued" as const,
              ...(detail === undefined ? {} : { detail }),
              ...(weight === undefined ? {} : { weight }),
            };
          }),
        ],
      }));
    }
    case "approval_requested": {
      const helper = event.helper ? helperEntry(state, event.helper.job) : undefined;
      state.approvals = [
        ...state.approvals.filter((approval) => approval.callId !== event.call_id),
        {
          reply: event.reply,
          callId: event.call_id,
          name: event.name,
          arguments: event.arguments,
          // An escalation carries the reviewer's reason itself; an older Spade sent it apart.
          reason: event.reviewer_reason || state.reviews.get(event.call_id),
          ...(event.ask ? { ask: event.ask } : {}),
          ...(event.stopped ? { stopped: event.stopped } : {}),
          ...(event.ask === "drive" && event.app ? { app: event.app } : {}),
          ...(event.helper ? { helper: { job: event.helper.job, task: helper?.task ?? "" } } : {}),
        },
      ];
      // Asked again: the request stands where it was first asked. Asked after the person
      // answered (a file it runs changed before it started), it is open again, with why.
      const asked = state.approvals.at(-1);
      if (
        asked &&
        !updateRequest(state, event.call_id, (request) => ({
          ...request,
          reason: asked.reason,
          ...(asked.stopped ? { stopped: asked.stopped } : {}),
          answer: undefined,
          always: false,
        }))
      ) {
        const request: { kind: "request"; key: string } & SpadeRequest = {
          kind: "request",
          key: `request:${event.call_id}`,
          callId: asked.callId,
          name: asked.name,
          arguments: asked.arguments,
          reason: asked.reason,
          ...(asked.ask ? { ask: asked.ask } : {}),
          ...(asked.stopped ? { stopped: asked.stopped } : {}),
          ...(asked.app ? { app: asked.app } : {}),
          ...(asked.helper ? { helper: asked.helper } : {}),
          answer: undefined,
          always: false,
        };
        // In the reply that asked, after its words so far; a helper's where it arrived.
        if (
          event.helper ||
          !updateOpen(state, event.reply, (entry) => ({
            ...entry,
            parts: [...entry.parts, request],
          }))
        )
          steer(state, { ...request, ...stamp(stored) });
      }
      // A helper's call is the helper's, not one of the reply's.
      if (!event.helper) setCall(state, event.reply, event.call_id, event.name, "waiting");
      return true;
    }
    case "plugin_outside_asked":
      state.outsideAsks = [
        ...state.outsideAsks.filter((ask) => ask.id !== event.id),
        {
          id: event.id,
          plugin: event.plugin,
          version: event.version,
          what: event.what,
          line: event.line,
        },
      ];
      return true;
    case "plugin_outside_answered":
      state.outsideAsks = state.outsideAsks.filter((ask) => ask.id !== event.id);
      return true;
    case "approval_answered":
      state.approvals = state.approvals.filter((approval) => approval.callId !== event.call_id);
      updateRequest(state, event.call_id, (request) => ({
        ...request,
        answer: event.allowed ? "allowed" : "denied",
        always: event.allowed && event.always === true,
      }));
      state.reviews.delete(event.call_id);
      if (!event.allowed) setCall(state, event.reply, event.call_id, undefined, "declined");
      return true;
    case "tool_started": {
      state.running.set(event.call_id, { reply: event.reply, name: event.name });
      setCall(state, event.reply, event.call_id, event.name, "running", stored.seq);
      // Spade's own word on what the call could change outweighs what its arguments read as.
      const weight = spadeRiskWeight(event.name, event.risk);
      if (weight)
        patchCall(state, event.reply, event.call_id, (part) =>
          part.weight === "destructive" || part.weight === weight ? undefined : { ...part, weight },
        );
      const effect = event.effect ?? undefined;
      if (effect)
        patchCall(state, event.reply, event.call_id, (part) =>
          part.effect === effect ? undefined : { ...part, effect },
        );
      return true;
    }
    case "command_ran":
      return patchCall(state, event.reply, event.call_id, (part) => ({
        ...part,
        ran: {
          contained: event.contained,
          exitCode: event.exit_code ?? undefined,
          timedOut: event.timed_out,
          reached: event.reached,
          refused: event.refused,
        },
      }));
    case "tool_finished":
      state.running.delete(event.call_id);
      setCall(
        state,
        event.reply,
        event.call_id,
        event.name,
        event.is_error ? "failed" : "done",
        stored.seq,
      );
      remembered(state, event.reply, key, event.name, event.content, event.is_error === true);
      if (spadeNeedsSearchSetup(event.name, event.content, event.is_error === true))
        updateReply(state, event.reply, (entry) =>
          // Once per reply, however often it searched.
          entry.parts.some((part) => part.kind === "search-setup")
            ? undefined
            : { ...entry, parts: [...entry.parts, { kind: "search-setup", key }] },
        );
      if (event.files.length)
        updateReply(state, event.reply, (entry) => ({
          ...entry,
          parts: [...entry.parts, { kind: "files", key: `${key}:files`, paths: event.files }],
        }));
      return true;
    case "shared":
      if (!event.images.length && !event.documents.length) return false;
      return updateReply(state, event.reply, (entry) => ({
        ...entry,
        parts: [
          ...entry.parts,
          { kind: "shared", key, images: event.images, documents: event.documents },
        ],
      }));
    case "question_asked": {
      // A call that stopped to ask the person (its sign-in to reconnect) runs no longer: the bot
      // waits on them, as for any question.
      if (state.running.delete(event.call_id))
        setCall(state, event.reply, event.call_id, undefined, "waiting");
      const questions = spadeCardQuestions(event.questions, event.question);
      // A call held on a Reconnect card that was refused again asks again, in the same place.
      const again = spadeConnectOf(questions)?.retry === true;
      const known = updateQuestion(state, event.call_id, (card) =>
        again && card.standing !== "waiting"
          ? { ...card, questions, standing: "waiting", answers: undefined, typed: false }
          : card,
      );
      if (known) {
        if (again && state.open?.reply === event.reply)
          state.question = { reply: event.reply, callId: event.call_id };
        // Asked again as a replay: the card already stands where it was first asked.
        return again;
      }
      const card: { kind: "question"; key: string } & SpadeQuestionCard = {
        kind: "question",
        key,
        callId: event.call_id,
        questions,
        standing: "waiting",
        answers: undefined,
        typed: false,
        askedForLater: false,
      };
      if (state.open?.reply === event.reply) {
        state.question = { reply: event.reply, callId: event.call_id };
        updateOpen(state, event.reply, (entry) => ({ ...entry, parts: [...entry.parts, card] }));
      } else steer(state, { ...card, standing: "closed", ...stamp(stored) });
      return true;
    }
    case "question_deferred": {
      if (state.question?.callId === event.call_id) state.question = undefined;
      const open = updateQuestion(state, event.call_id, (card) =>
        card.standing === "waiting" || card.standing === "closed"
          ? { ...card, standing: "deferred", askedForLater: event.by_bot === true }
          : undefined,
      );
      if (open) state.forLater.add(event.call_id);
      return open;
    }
    case "question_answered":
      if (state.question?.callId === event.call_id) state.question = undefined;
      state.forLater.delete(event.call_id);
      return updateQuestion(state, event.call_id, (card) => ({
        ...card,
        standing: "answered",
        answers: event.answers,
        typed: card.typed || event.typed === true,
      }));
    case "question_dismissed":
      if (state.question?.callId === event.call_id) state.question = undefined;
      state.forLater.delete(event.call_id);
      return updateQuestion(state, event.call_id, (card) => ({ ...card, standing: "dismissed" }));
    case "job_started":
      if (event.name === spadeHelperTool)
        // Its line, where it started: the reply's later words read below it.
        steer(state, {
          kind: "helper",
          key,
          job: event.job,
          task: spadeHelperTask(state.calls.get(event.job)?.arguments),
          outcome: undefined,
          result: "",
          ...stamp(stored),
        });
      state.jobs.set(event.job, {
        name: event.name,
        agents: delegatedTasks(state.calls.get(event.job)?.arguments),
        reply: event.reply,
      });
      return true;
    case "job_finished": {
      state.jobs.delete(event.job);
      const stopped = state.stopping.delete(event.job);
      const outcome = event.is_error ? (stopped ? "stopped" : "failed") : "done";
      // An ended helper asks nothing more.
      state.approvals = state.approvals.filter((approval) => approval.helper?.job !== event.job);
      const at = state.entries.findIndex(
        (entry) => entry.kind === "helper" && entry.job === event.job,
      );
      const line = state.entries[at];
      if (line?.kind === "helper") {
        state.entries[at] = { ...line, outcome, result: event.content ?? "" };
        return true;
      }
      // Its result goes to Spade like a message: what Spade says about it reads below it.
      steer(state, { kind: "job", key, name: event.name, outcome, files: event.files });
      return true;
    }
    case "call_reviewed": {
      // A refusal returns to the bot as `Not run: <reason>`; its step says so (ADR 0163).
      if (event.verdict === "refuse") return refuseCall(state, event.call_id, event.reason);
      if (event.verdict !== "escalate") return false;
      state.reviews.set(event.call_id, event.reason);
      updateRequest(state, event.call_id, (request) => ({ ...request, reason: event.reason }));
      const at = state.approvals.findIndex((approval) => approval.callId === event.call_id);
      const asked = state.approvals[at];
      if (!asked) return false;
      state.approvals = state.approvals.with(at, { ...asked, reason: event.reason });
      return true;
    }
    case "reply_finished":
      return closeReply(state, event.reply, { kind: "finished" }, event.text);
    case "reply_stopped":
      return closeReply(state, event.reply, { kind: "stopped" }, event.text);
    case "reply_failed":
      return closeReply(
        state,
        event.reply,
        {
          kind: "failed",
          error: event.error,
          failure: event.kind,
          endpoint: event.endpoint ?? undefined,
        },
        event.text,
      );
    case "reply_interrupted":
      return closeReply(state, event.reply, { kind: "interrupted" }, event.text);
    case "reply_retried": {
      // The next reply answers the same turn in its place: the failure goes, and so do the words
      // its failed call left unfinished (no step stored them), which the model no longer reads
      // either; what its finished steps said and did stays.
      const index = replyAt(state, event.reply);
      const entry = index === undefined ? undefined : state.entries[index];
      if (index === undefined || entry?.kind !== "reply" || entry.end?.kind !== "failed")
        return false;
      const parts = entry.parts.filter((part) => part.key !== `${entry.key}:end`);
      state.entries[index] = { ...entry, parts, end: { kind: "finished" } };
      return true;
    }
    case "task_paused":
      state.entries.push({ kind: "task-paused", key, reason: event.reason, steps: event.steps });
      return true;
    case "context_compacted":
      state.entries.push({ kind: "compacted", key });
      return true;
    case "computer_handed_back":
      state.entries.push({
        kind: "handback",
        key,
        text: event.text,
        data: (event.data ?? []).filter((item): item is string => typeof item === "string"),
      });
      return true;
    // Stop's own record: the reply's end and the jobs' ends that follow it say what happened.
    case "stop_requested": {
      for (const job of event.jobs) state.stopping.add(job);
      for (const [job, running] of state.jobs)
        if (event.reply && running.reply === event.reply) state.stopping.add(job);
      // An approval for a stopped reply can no longer be answered.
      const before = state.approvals.length;
      if (event.reply) state.approvals = state.approvals.filter((a) => a.reply !== event.reply);
      const asked = state.question !== undefined && state.question.reply === event.reply;
      if (asked && state.question) {
        const { callId } = state.question;
        updateQuestion(state, callId, (card) =>
          card.standing === "waiting" ? { ...card, standing: "closed" } : undefined,
        );
        state.question = undefined;
      }
      return state.approvals.length !== before || asked;
    }
    case "renamed":
      if (state.title === event.title) return false;
      state.title = event.title;
      return true;
    case "agent_configured": {
      // Only the bot's own rewrites show; the person's edits are theirs, already seen.
      const change = event.change;
      if (!change || change.by !== "bot") return false;
      steer(state, {
        kind: "task-changed",
        key,
        task: event.task,
        previous: change.previous,
        why: change.why,
        ...stamp(stored),
      });
      return true;
    }
    case "bot_made":
      steer(state, {
        kind: "made",
        key,
        bot: event.bot,
        name: event.name,
        task: event.task,
        ...stamp(stored),
      });
      return true;
    case "club_added":
      steer(state, {
        kind: "club-added",
        key,
        club: event.club,
        clubName: event.club_name,
        bot: event.bot,
        botName: event.bot_name,
        ...stamp(stored),
      });
      return true;
    case "profile_changed": {
      if (event.by !== "bot") return false;
      const first = !state.entries.some((entry) => entry.kind === "named");
      steer(state, {
        kind: "named",
        key,
        name: event.name,
        face: event.face,
        first,
        ...stamp(stored),
      });
      return true;
    }
  }
}

const sameImages = (a: readonly SpadeImageRef[], b: readonly SpadeImageRef[]) =>
  a.length === b.length && a.every((image, index) => image.sha256 === b[index]?.sha256);

/** The same file: by hash when both know it, else by name and size. */
const sameDocument = (a: SpadeDocumentRef, b: SpadeDocumentRef) =>
  a.sha256 && b.sha256 ? a.sha256 === b.sha256 : a.name === b.name && a.bytes === b.bytes;

const sameDocuments = (a: readonly SpadeDocumentRef[], b: readonly SpadeDocumentRef[]) =>
  a.length === b.length && a.every((document, index) => sameDocumentAt(document, b[index]));
const sameDocumentAt = (a: SpadeDocumentRef, b: SpadeDocumentRef | undefined) =>
  b !== undefined && sameDocument(a, b);

/** Both carry no recording, or the same one (by hash when both know it, else by size). */
const sameVoice = (a: SpadeVoiceRef | undefined, b: SpadeVoiceRef | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.sha256 && b.sha256
      ? a.sha256 === b.sha256
      : a.bytes === b.bytes;

/**
 * Whether Spade's stored `event` is the person's pending `message`: the same words, images,
 * documents and recording. A stored message that only shares the words is another one.
 */
const sameMessage = (
  message: SpadePendingMessage,
  event: Extract<SpadeKnownEvent, { type: "user_message" }>,
) =>
  message.text === event.text &&
  sameImages(message.images, event.images) &&
  sameDocuments(message.documents ?? [], event.documents) &&
  sameVoice(message.voice, event.voice);

/**
 * A message while a reply is open steers it: the reply carries on under the message, so what
 * Spade says next reads after it. The open step's words so far move down with it.
 */
/** The line of the helper running `job`, if this conversation shows one. */
function helperEntry(state: SpadeConversationState, job: string) {
  const line = state.entries.find((entry) => entry.kind === "helper" && entry.job === job);
  return line?.kind === "helper" ? line : undefined;
}

/** The note ids a message's fixed context recalled (`- [n_4] …` lines); nothing for none. */
function recalledOf(context: string | null | undefined): { recalled?: readonly string[] } {
  const ids = [...(context ?? "").matchAll(/^- \[(n_[A-Za-z0-9_-]+)\]/gm)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
  return ids.length ? { recalled: [...new Set(ids)] } : {};
}

/** When Spade stored an event, for the entry it makes; nothing when the event had no time. */
const stamp = (stored: SpadeStored): { at?: number } => (stored.at > 0 ? { at: stored.at } : {});

function steer(state: SpadeConversationState, message: SpadeEntry) {
  const open = state.open;
  const entry = open && state.entries[open.index];
  if (!open || entry?.kind !== "reply") {
    state.entries.push(message);
    return;
  }
  if (entry.parts.length) state.entries[open.index] = { ...entry, live: "" };
  else state.entries.splice(open.index, 1);
  state.entries.push(message, { ...entry, key: `${entry.key}@${message.key}`, parts: [] });
  open.index = state.entries.length - 1;
}

/** A memory tool's result that saved or rewrote a note shows as its one line in the reply. */
function remembered(
  state: SpadeConversationState,
  reply: string,
  key: string,
  name: string,
  content: unknown,
  isError: boolean,
) {
  const note = spadeRemembered(name, content, isError);
  if (note)
    updateReply(state, reply, (entry) => ({
      ...entry,
      parts: [...entry.parts, { kind: "remembered", key, note }],
    }));
}

/**
 * Change the request for `callId` where it stands, the newest first: a reply's part or an entry
 * of its own. Answers come soon after the ask, so the walk back is short. False when none is.
 */
function updateRequest(
  state: SpadeConversationState,
  callId: string,
  change: (request: SpadeRequest) => SpadeRequest,
): boolean {
  return updatePlaced(state, "request", callId, change);
}

/**
 * Change the card for `callId` where it stands, as `updateRequest` does. `change` returns
 * undefined to leave it; true only when the card is there and changed. A deferred card may be
 * answered long after: the walk back goes as far as it is.
 */
function updateQuestion(
  state: SpadeConversationState,
  callId: string,
  change: (card: SpadeQuestionCard) => SpadeQuestionCard | undefined,
): boolean {
  return updatePlaced(state, "question", callId, change);
}

type Placed = Extract<SpadeEntry, { kind: "request" | "question" }>;

function updatePlaced<K extends Placed["kind"], T>(
  state: SpadeConversationState,
  kind: K,
  callId: string,
  change: (item: T) => T | undefined,
): boolean {
  const fits = (item: { kind: string; callId?: string }): item is Extract<Placed, { kind: K }> =>
    item.kind === kind && item.callId === callId;
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (!entry) continue;
    if (fits(entry)) {
      const next = change(entry as T);
      if (next !== undefined) state.entries[index] = { ...entry, ...next };
      return next !== undefined;
    }
    if (entry.kind !== "reply") continue;
    const at = entry.parts.findIndex(fits);
    const part = entry.parts[at];
    if (!part || !fits(part)) continue;
    const next = change(part as T);
    if (next === undefined) return false;
    state.entries[index] = { ...entry, parts: entry.parts.with(at, { ...part, ...next }) };
    return true;
  }
  return false;
}

/** Replace the open reply's entry when it is `reply`; `change` returns undefined for no change. */
/** Change the open reply's live text; only an open reply streams. */
function updateOpen(
  state: SpadeConversationState,
  reply: string,
  change: (entry: SpadeReplyEntry) => SpadeReplyEntry | undefined,
): boolean {
  if (state.open?.reply !== reply) return false;
  return changeAt(state, state.open.index, change);
}

/**
 * Where reply `reply` stands: the open reply's place, else its latest part (a steered reply's
 * parts share its id). Steps of a reply that already ended still land in it, by its id.
 */
function replyAt(state: SpadeConversationState, reply: string): number | undefined {
  if (state.open?.reply === reply) return state.open.index;
  const index = state.entries.findLastIndex(
    (entry) => entry.kind === "reply" && entry.reply === reply,
  );
  return index < 0 ? undefined : index;
}

/** Change reply `reply` by its id, open or not (`replyAt`). */
function updateReply(
  state: SpadeConversationState,
  reply: string,
  change: (entry: SpadeReplyEntry) => SpadeReplyEntry | undefined,
): boolean {
  const index = replyAt(state, reply);
  return index !== undefined && changeAt(state, index, change);
}

function changeAt(
  state: SpadeConversationState,
  index: number,
  change: (entry: SpadeReplyEntry) => SpadeReplyEntry | undefined,
): boolean {
  const entry = state.entries[index];
  if (entry?.kind !== "reply") return false;
  const next = change(entry);
  if (!next) return false;
  state.entries[index] = next;
  return true;
}

function setCall(
  state: SpadeConversationState,
  reply: string,
  callId: string,
  name: string | undefined,
  callState: SpadeCallState,
  /** The event's seq, kept as the call's `logged` when it has none yet. */
  seq?: number,
) {
  // Where the call stands: as the open reply recorded it, or, once its reply ended, found in
  // that reply by its id (a result that arrives late still lands on its own step).
  const index = state.calls.get(callId)?.index ?? callIn(state, reply, callId);
  const entry = index === undefined ? undefined : state.entries[index];
  if (index !== undefined && entry?.kind === "reply") {
    const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
    const part = entry.parts[at];
    if (part?.kind !== "call") return;
    // `call_tool` reaches a deferred tool; once Spade names that tool, the call reads as it.
    const named = name && part.name === "call_tool" ? name : part.name;
    const logged = part.logged ?? seq;
    // Spade answers a declined call with an errored result; it stays what the person chose. A
    // refused call's result is its refusal, so it stays refused.
    const next =
      part.state === "declined" && callState === "failed"
        ? "declined"
        : part.state === "refused" && (callState === "done" || callState === "failed")
          ? "refused"
          : callState;
    if (part.state === next && named === part.name && logged === part.logged) return;
    const parts = entry.parts.slice();
    parts[at] = {
      ...part,
      name: named,
      state: next,
      ...(logged === undefined ? {} : { logged }),
    };
    state.entries[index] = { ...entry, parts };
    return;
  }
  if (!name) return;
  // A call no step listed (an older Spade): it shows where its reply is now.
  const last = replyAt(state, reply);
  if (last === undefined) return;
  if (state.open?.reply === reply) state.calls.set(callId, { reply, index: last });
  changeAt(state, last, (open) => ({
    ...open,
    parts: [
      ...open.parts,
      {
        kind: "call",
        key: callId,
        name,
        state: callState,
        ...(seq === undefined ? {} : { logged: seq }),
      },
    ],
  }));
}

type CallPart = Extract<SpadeReplyPart, { kind: "call" }>;

/**
 * Change call `callId` of reply `reply` where its step stands (as `setCall` finds it); false when
 * no step lists it or `change` leaves it as it is.
 */
function patchCall(
  state: SpadeConversationState,
  reply: string,
  callId: string,
  change: (part: CallPart) => CallPart | undefined,
): boolean {
  const index = state.calls.get(callId)?.index ?? callIn(state, reply, callId);
  const entry = index === undefined ? undefined : state.entries[index];
  if (index === undefined || entry?.kind !== "reply") return false;
  const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
  const part = entry.parts[at];
  if (part?.kind !== "call") return false;
  const next = change(part);
  if (!next) return false;
  state.entries[index] = { ...entry, parts: entry.parts.with(at, next) };
  return true;
}

/** Mark call `callId` refused by the auto-review, with its reason, wherever its step stands. */
function refuseCall(state: SpadeConversationState, callId: string, reason: string): boolean {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry?.kind !== "reply") continue;
    const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
    const part = entry.parts[at];
    if (part?.kind !== "call") continue;
    state.entries[index] = {
      ...entry,
      parts: entry.parts.with(at, { ...part, state: "refused", reason: reason.trim() }),
    };
    return true;
  }
  return false;
}

/** The part of reply `reply` (a steered reply has several) that lists call `callId`. */
function callIn(state: SpadeConversationState, reply: string, callId: string) {
  const index = state.entries.findLastIndex(
    (entry) =>
      entry.kind === "reply" &&
      entry.reply === reply &&
      entry.parts.some((part) => part.kind === "call" && part.key === callId),
  );
  return index < 0 ? undefined : index;
}

const unsettled = new Set<SpadeCallState>(["queued", "waiting", "running"]);

function setCallAt(state: SpadeConversationState, index: number, callId: string) {
  const entry = state.entries[index];
  if (entry?.kind !== "reply") return;
  const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
  const part = entry.parts[at];
  if (part?.kind !== "call" || !unsettled.has(part.state)) return;
  const parts = entry.parts.slice();
  parts[at] = { ...part, state: "skipped" };
  state.entries[index] = { ...entry, parts };
}

function closeReply(
  state: SpadeConversationState,
  reply: string,
  end: SpadeReplyEnd,
  text: string,
): boolean {
  if (state.open?.reply !== reply) return false;
  closeOpen(state, end, text);
  return true;
}

/** The last words reply `reply` said, in its part at `index` or the parts above it. */
function lastWords(state: SpadeConversationState, index: number, reply: string) {
  for (let at = index; at >= 0; at--) {
    const entry = state.entries[at];
    if (entry?.kind !== "reply") continue;
    // Another reply above: this one's parts all sit below it.
    if (entry.reply !== reply) return undefined;
    const text = entry.parts.findLast((part) => part.kind === "text");
    if (text) return text;
  }
  return undefined;
}

/**
 * End the open reply. A finished reply's text repeats its last step's, already shown; any other
 * end carries the open step's words, which no step stored.
 */
function closeOpen(state: SpadeConversationState, end: SpadeReplyEnd, text: string) {
  const open = state.open;
  if (!open) return;
  const entry = state.entries[open.index];
  if (entry?.kind === "reply") {
    // A steered reply's last words may sit in an earlier part of it, above what steered it.
    const last = lastWords(state, open.index, entry.reply);
    const words = end.kind === "finished" ? (last?.text === text ? "" : text) : text || entry.live;
    const parts: SpadeReplyPart[] = words.trim()
      ? [...entry.parts, { kind: "text", key: `${entry.key}:end`, text: words }]
      : entry.parts.slice();
    state.entries[open.index] = { ...entry, parts, live: "", end };
  }
  // A call left without a result when the reply ended never ran.
  for (const [callId, call] of state.calls) {
    if (call.reply !== open.reply) continue;
    setCallAt(state, call.index, callId);
    state.calls.delete(callId);
  }
  // A helper's approval waits on the helper, not on the reply that started it.
  state.approvals = state.approvals.filter(
    (approval) => approval.helper !== undefined || approval.reply !== open.reply,
  );
  // A card still waiting when its turn ended can no longer be answered.
  if (state.question?.reply === open.reply) {
    const { callId } = state.question;
    updateQuestion(state, callId, (card) =>
      card.standing === "waiting" ? { ...card, standing: "closed" } : undefined,
    );
    state.question = undefined;
  }
  for (const [callId, call] of state.running)
    if (call.reply === open.reply) state.running.delete(callId);
  state.open = undefined;
}
