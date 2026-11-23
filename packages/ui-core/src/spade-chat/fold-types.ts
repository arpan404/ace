/*
 * The shapes a Spade conversation's fold builds (`foldSpade`): its entries, replies and their
 * parts, requests and question cards, and the state it keeps. Types only, beside one rule on them.
 */

import type { SpadeRememberedNote } from "./notes.ts";
import type { SpadeDocumentRef, SpadeImageRef, SpadeVoiceRef } from "./media.ts";
import type { SpadeFailureKind, SpadeLiveInput, SpadeStoppedKind } from "./wire.ts";
import type { SpadeContractAsked, SpadeContractEntry, SpadeTalkEntry } from "./bot-talk.ts";
import type { SpadeQuestion, SpadeQuestionStanding } from "./questions.ts";
import type { SpadeCapabilityState } from "./fold-capabilities.ts";
import type { SpadeQuiet } from "./quiet.ts";
import type { SpadeWorkersEntry } from "./delegations.ts";
import type { SpadeDecision } from "./decisions.ts";
import type { SpadeCardRow } from "./cards.ts";
import type { SpadeNoticeRow } from "./notices.ts";
import type { SpadeStepWeight } from "./step-facts.ts";
import type { SpadeRefusedHost } from "./wire.ts";
import type { SpadeReplyTo } from "./replies.ts";

/** A background job: the tool it runs and, for a delegation, how many tasks it handed out. */
export interface SpadeJob {
  name: string;
  agents: number | undefined;
  /** The reply that started it, whose Stop also stops it. */
  reply: string;
  /** When it started (ms), for the working line's clock when no reply is open; unknown at 0. */
  startedAt?: number | undefined;
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
  /** `seq`: the stored event holding the words, which names its messages (ADR 0212 §3). */
  | { kind: "text"; key: string; text: string; seq?: number }
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
      /** Why the review refused the call or why the call failed. */
      reason?: string;
      reviewedAllow?: true;
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
  /** The next step ran on another model of the bot's route: where, and why (ADR 0205 §2). */
  | { kind: "served"; key: string; line: string }
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
      /** Sent by another bot, not the person; with the contract call it delivers, if one. */
      fromAgent?: { id: string; name: string; contract?: SpadeContractAsked };
      /** Fired by one of the bot's routines or its heartbeat, not the person. */
      fromRoutine?: { id: string; name: string; label: string; heartbeat: boolean };
      /** Sent here from a group the bot is in (ADR 0132). */
      fromGroup?: { id: string; name: string };
      /** Written by the person in an ace thread (ADR 0198). */
      fromThread?: { id: string; title: string; machine?: string | undefined };
      /** When Spade stored it; a message not stored yet has none. */
      at?: number;
      /** The notes Spade recalled for it, by id: what the reply to it had in mind (ADR 0128). */
      recalled?: readonly string[];
      /** Its message id (ADR 0212 §3); a message not stored yet has none. */
      id?: string;
      /** The message it replies to (ADR 0212 §4). */
      replyTo?: SpadeReplyTo;
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
  /** A call this bot made to another bot's contract (ADR 0200 §7), settled in place. */
  | SpadeContractEntry
  /** The messages one turn sent another bot, with their replies, as one card (`bot-talk.ts`). */
  | SpadeTalkEntry
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
  | { kind: "quiet"; key: string; quiet: SpadeQuiet; at?: number }
  /** The bots and ace agents one call started, as one card where the first started. */
  | SpadeWorkersEntry
  /**
   * A card the bot showed (ADR 0200 §5.1): its own row where it was first shown, updated in
   * place by each later version.
   */
  | ({ kind: "card"; key: string; at?: number } & SpadeCardRow)
  /** A bot's own notice (`notify`, ADR 0200 §4.2), where it was sent, with what became of it. */
  | ({ kind: "notice"; key: string; at?: number } & SpadeNoticeRow);

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
  /** A task lane's card (ADR 0217 §4), asked in main too: the task that asks it. */
  lane?: SpadeLaneAsking;
}

export type SpadeAskKind = "undeclared" | "outside_sandbox" | "drive" | "app";

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
  /**
   * For a driving step, the app or site its "always" allows for the bot; for a connected app's
   * write (`ask: "app"`), the connection whose writes the person may allow always.
   */
  app?: string;
  /** What the gate read the call as doing (`read`, `network`, `send_as_person`…); absent: undeclared. */
  effect?: string;
  /** For a connected app's tool, the definition the person is shown. */
  definition?: string;
  helper?: { job: string; task: string };
  lane?: SpadeLaneAsking;
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
  effect?: string;
  definition?: string;
  /** A helper's call (ADR 0152): its job and task. It outlives the reply that started it. */
  helper?: { job: string; task: string };
  /** A task lane's call (ADR 0217 §4), asked in main: answered here, it reaches the lane. */
  lane?: SpadeLaneAsking;
}

/** The task lane a request came from: its id and title. */
export interface SpadeLaneAsking {
  task: string;
  title: string;
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
  /** The latest state the bot set on each of its panels (ADR 0200 §5.2), by panel id. */
  panels: Map<string, unknown>;
}

/** What a `status` frame said, and the last `seq` folded when it came. */
export interface SpadeReported {
  state: "idle" | "working" | "waiting" | "sleeping" | "paused" | "updating";
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
  replyTo?: SpadeReplyTo;
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
      replyTo?: SpadeReplyTo;
    }
  | { kind: "refused"; key: string };
