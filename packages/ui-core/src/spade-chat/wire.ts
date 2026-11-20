import { z } from "zod";
import { spadeJson as json } from "./json.ts";
import { spadeDocumentList, spadeImageList, spadeVoiceField } from "./media.ts";
import { spadeCapabilityEvents } from "./wire-capabilities.ts";
import { spadeCardEvents } from "./cards.ts";

/**
 * Why a reply failed (`reply_failed`'s `kind`): the endpoint couldn't be reached, refused the key,
 * is rate limiting, the model failed, the bot has no model it can use (none chosen yet, or its
 * model is gone from the person's endpoints), or anything else. Spade has no spending caps (ADR
 * 0166): a `cap` an older Spade stored reads as `other`.
 */
export const spadeFailureKinds = [
  "unreachable",
  "key",
  "rate_limited",
  "model",
  "no_model",
  "other",
] as const;
export type SpadeFailureKind = (typeof spadeFailureKinds)[number];

/**
 * Which of Spade's judges stopped a call and put it to the person rather than refuse it (ADR 0163,
 * amendment 3): the reviewer, the second review, Spade's classifier, or a check that couldn't
 * vouch for what a command outside the sandbox runs (part of it unreadable, unreadable again
 * before it started, or a file changed while it waited).
 */
export const spadeStoppedKinds = [
  "reviewer",
  "second_review",
  "classifier",
  "incomplete",
  "unread",
  "changed",
] as const;
export type SpadeStoppedKind = (typeof spadeStoppedKinds)[number];

/*
 * Spade's own bodies, as its local API writes them (spade/docs/chat-core.md, harness.md). The
 * daemon passes them through as text, so every client parses them here, leniently: an event
 * type this client doesn't know is kept as raw data, a field it doesn't know is ignored.
 */

const text = z.string();
const reply = z.string();
/** Workspace files a tool kept, for file chips; a path this client can't read is left out. */
const files = z
  .array(z.unknown())
  .nullish()
  .catch(undefined)
  .transform((list) =>
    (list ?? []).filter((path): path is string => typeof path === "string" && path !== ""),
  );

export type { SpadeImageRef } from "./media.ts";

/** A host Spade's network policy refused a command (`command_ran`), with why. */
const refusedHost = z.object({
  host: z.string().min(1),
  port: z.number().int().nonnegative().catch(0),
  reason: z.string().catch(""),
});
export type SpadeRefusedHost = z.infer<typeof refusedHost>;

/** The stored event types the person's view reads. Anything else is kept as `unknown`. */
const known = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    text: text.default(""),
    /** Another bot that sent this message into the conversation (ADR 0127). */
    from_agent: z
      .object({ id: z.string(), name: z.string().catch("") })
      .nullish()
      .catch(undefined),
    /** One of the bot's routines or its heartbeat fired it (ADR 0129). */
    from_routine: z
      .object({
        id: z.string(),
        name: z.string().catch(""),
        label: z.string().catch(""),
        heartbeat: z.boolean().catch(false).default(false),
      })
      .nullish()
      .catch(undefined),
    /** A group sent it to this bot (ADR 0132): a person's or another member's words there. */
    from_group: z
      .object({ id: z.string(), name: z.string().catch("") })
      .nullish()
      .catch(undefined),
    /** The person wrote it in an ace thread (ADR 0198): the thread, to link back to. */
    from_thread: z
      .object({
        id: z.string().min(1),
        title: z.string().catch(""),
        /** The person's other machine the thread is on; absent for this machine's. */
        machine: z.string().max(256).optional().catch(undefined),
      })
      .nullish()
      .catch(undefined),
    // An image, document or recording this client can't read is left out; the message shows.
    images: spadeImageList,
    documents: spadeDocumentList,
    /** A voice message's recording; `text` is its transcript (ADR 0134). */
    voice: spadeVoiceField,
    /** What Spade fixed with it: the time, and the notes it recalled (`- [n_…] text`). */
    context: z.string().nullish().catch(undefined),
  }),
  z.object({ type: z.literal("reply_started"), reply, model: z.string().optional() }),
  z.object({ type: z.literal("reply_progress"), reply, text }),
  z.object({
    type: z.literal("step_finished"),
    reply,
    text: text.default(""),
    calls: z
      .array(z.looseObject({ id: z.string(), name: z.string(), arguments: z.unknown().optional() }))
      .optional()
      .default([]),
  }),
  z.object({ type: z.literal("reply_finished"), reply, text: text.default("") }),
  z.object({ type: z.literal("reply_stopped"), reply, text: text.default("") }),
  z.object({
    type: z.literal("reply_failed"),
    reply,
    text: text.default(""),
    error: z.string().default(""),
    // Missing on events from before kinds, or one this client doesn't know: `other`.
    kind: z.enum(spadeFailureKinds).catch("other").default("other"),
    endpoint: z.string().nullish().catch(undefined),
  }),
  z.object({ type: z.literal("reply_interrupted"), reply, text: text.default("") }),
  /** Try again on `reply`, which failed: the reply stored next takes its place. */
  z.object({ type: z.literal("reply_retried"), reply }),
  z.object({
    type: z.literal("approval_requested"),
    reply,
    call_id: z.string(),
    name: z.string(),
    arguments: z.unknown().optional(),
    /** Why the auto-review asked the person rather than approve it itself. */
    reviewer_reason: z.string().nullish().catch(undefined),
    /** Why Spade asked (ADR 0171); missing on older events, or a reason this client doesn't know. */
    ask: z.enum(["undeclared", "outside_sandbox", "drive"]).nullish().catch(undefined),
    /**
     * Which of Spade's judges stopped the call and put it to the person (ADR 0163, amendment 3);
     * missing on older events and other requests, or a word this client doesn't know.
     */
    stopped: z.enum(spadeStoppedKinds).nullish().catch(undefined),
    /** A driving step's app or site its "always" allows for the bot, when it may be allowed. */
    app: z.string().min(1).max(200).nullish().catch(undefined),
    /** A helper's call (ADR 0152), asked here in its bot's conversation. */
    helper: z
      .object({ job: z.string(), conversation: z.string(), call_id: z.string() })
      .nullish()
      .catch(undefined),
  }),
  /**
   * A plugin's server or hook the sandbox can't seal off asks to run outside it (ADR 0167): it
   * waits for the person, and doesn't start until they allow it.
   */
  z.object({
    type: z.literal("plugin_outside_asked"),
    id: z.string(),
    plugin: z.string(),
    version: z.string(),
    what: z.string(),
    line: z.string(),
  }),
  z.object({
    type: z.literal("plugin_outside_answered"),
    id: z.string(),
    allowed: z.boolean(),
    always: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("approval_answered"),
    reply,
    call_id: z.string(),
    allowed: z.boolean(),
    always: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("tool_started"),
    reply,
    call_id: z.string(),
    name: z.string(),
    /** How much the call could change (`read`, `write`, `memory`, `destructive`); missing from older events. */
    risk: z.string().nullish().catch(undefined),
    /** What the tool declared it does, as the gate read it (`send_as_person`, `pay`…); missing from older events. */
    effect: z.string().nullish().catch(undefined),
  }),
  z.object({
    type: z.literal("tool_finished"),
    reply,
    call_id: z.string(),
    name: z.string(),
    /** The result: JSON text from the memory tools, which the view reads (ADR 0128). */
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
    files,
  }),
  /**
   * Images and documents a tool showed the person, stored right after its `tool_finished`
   * (ADR 0134): they show in the reply's bubble, after its words.
   */
  z.object({
    type: z.literal("shared"),
    reply,
    call_id: z.string().optional(),
    images: spadeImageList,
    documents: spadeDocumentList,
  }),
  /**
   * Where a command ran and how, stored right after its `tool_finished` (harness.md): whether
   * Spade's sandbox held it, its exit, and the hosts it reached and its network policy refused.
   * A host this client can't read is left out; the step still shows.
   */
  z.object({
    type: z.literal("command_ran"),
    reply,
    call_id: z.string(),
    contained: z.boolean().optional().catch(undefined),
    exit_code: z.number().int().nullish().catch(undefined),
    timed_out: z.boolean().catch(false).default(false),
    reached: z
      .array(z.unknown())
      .nullish()
      .catch(undefined)
      .transform((list) =>
        (list ?? []).filter((host): host is string => typeof host === "string" && host !== ""),
      ),
    refused: z
      .array(z.unknown())
      .nullish()
      .catch(undefined)
      .transform((list) =>
        (list ?? []).flatMap((each) => {
          const parsed = refusedHost.safeParse(each);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
  }),
  /**
   * The bot asked the person a card of questions (ADR 0128, 0154). `question` is the prompts,
   * one per line; `questions` each with its kind (absent from a Spade before kinds: one text
   * question), read by `spadeCardQuestions`.
   */
  z.object({
    type: z.literal("question_asked"),
    reply,
    call_id: z.string(),
    question: z.string().catch(""),
    questions: z.unknown().optional(),
  }),
  /** Left for later, by the person or by the bot asking without waiting. */
  z.object({
    type: z.literal("question_deferred"),
    call_id: z.string(),
    by_bot: z.boolean().nullish().catch(undefined),
  }),
  /** The answers, one per question; `late` once deferred, `typed` when a message stood for them. */
  z.object({
    type: z.literal("question_answered"),
    call_id: z.string(),
    answers: z.array(z.unknown()).catch([]),
    late: z.boolean().nullish().catch(undefined),
    typed: z.boolean().nullish().catch(undefined),
  }),
  z.object({
    type: z.literal("question_dismissed"),
    call_id: z.string(),
    late: z.boolean().nullish().catch(undefined),
  }),
  z.object({ type: z.literal("job_started"), reply, job: z.string(), name: z.string() }),
  z.object({
    type: z.literal("job_finished"),
    job: z.string(),
    name: z.string(),
    /** The result the model reads; a helper's line shows its first words (ADR 0152). */
    content: z.string().optional().catch(undefined),
    is_error: z.boolean().optional(),
    files,
  }),
  // `cap_reached` (ADR 0135) is gone with the caps (ADR 0166): one an older Spade stored is
  // kept as raw data and shows nothing.
  /** The model review judged a call before it ran (ADR 0135). */
  z.object({
    type: z.literal("call_reviewed"),
    reply: z.string().nullish().catch(undefined),
    call_id: z.string(),
    name: z.string().catch(""),
    verdict: z.string(),
    reason: z.string().catch("").default(""),
  }),
  z.object({
    type: z.literal("task_paused"),
    reason: z.enum(["budget", "no_progress"]),
    steps: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("context_compacted") }),
  z.object({
    type: z.literal("stop_requested"),
    reply: z.string().nullish(),
    jobs: z.array(z.string()).optional().default([]),
  }),
  z.object({ type: z.literal("renamed"), title: z.string() }),
  /**
   * The person handed the bot's computer back: Spade's narration of what they did (never what
   * they typed), and the names involved as untrusted data (`new: path`, `went to: address`).
   */
  z.object({
    type: z.literal("computer_handed_back"),
    text: z.string(),
    data: z.array(z.unknown()).optional(),
  }),
  /**
   * The bot's task or model changed (spade/docs/agents.md). `change` says who changed the task,
   * from what and why; missing on a change of model alone and on events from before task history.
   */
  z.object({
    type: z.literal("agent_configured"),
    task: z.string().catch(""),
    change: z
      .object({
        by: z.string().catch(""),
        previous: z.string().catch(""),
        why: z.string().catch("").default(""),
      })
      .nullish()
      .catch(undefined),
  }),
  /** This bot made a standing bot for the person (ADR 0161, amendment 1). */
  z.object({
    type: z.literal("bot_made"),
    bot: z.string(),
    name: z.string().catch(""),
    task: z.string().catch(""),
  }),
  /** This bot added a bot to a club it is in. */
  z.object({
    type: z.literal("club_added"),
    club: z.string(),
    club_name: z.string().catch(""),
    bot: z.string(),
    bot_name: z.string().catch(""),
  }),
  /** The bot's name or face changed; `by` is `bot` (it named itself) or `person`. */
  z.object({
    type: z.literal("profile_changed"),
    name: z.string().catch(""),
    by: z.string().catch(""),
    face: z.boolean().catch(false).default(false),
  }),
  ...spadeCapabilityEvents,
  ...spadeCardEvents,
]);

export type SpadeKnownEvent = z.infer<typeof known>;
/** A stored event: one this client reads, or one it keeps as it came and ignores. */
export type SpadeEvent = SpadeKnownEvent | { type: "unknown"; raw: unknown };

/** One stored event as `events` and the live stream's `stored` frames carry it. */
export interface SpadeStored {
  seq: number;
  at: number;
  event: SpadeEvent;
}

const storedShape = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number().default(0),
  event: z.unknown(),
});

/** An event body: known when it fits a known type, otherwise kept whole. */
export function parseSpadeEvent(raw: unknown): SpadeEvent {
  const parsed = known.safeParse(raw);
  return parsed.success ? parsed.data : { type: "unknown", raw };
}

/** A `{seq, at, event}` value; undefined when it has no usable `seq`. */
export function parseSpadeStored(raw: unknown): SpadeStored | undefined {
  const parsed = storedShape.safeParse(raw);
  if (!parsed.success) return undefined;
  return { seq: parsed.data.seq, at: parsed.data.at, event: parseSpadeEvent(parsed.data.event) };
}

const replyText = z.object({ reply: z.string(), text: z.string() });
const caughtUpShape = z.object({ seq: z.number().int().nonnegative() });
/** A group's member as a status frame names it (ADR 0132). */
const waitingMemberShape = z.object({
  id: z.string(),
  name: z.string(),
  machine: z
    .string()
    .nullish()
    .transform((machine) => machine ?? null),
});
const statusShape = z.object({
  /**
   * `sleeping`: it sleeps or waits on a wake (ADR 0160), never idle or done. `paused`: the person
   * paused it (ADR 0200 §6.1).
   */
  state: z.enum(["idle", "working", "waiting", "sleeping", "paused"]),
  status: z.string().nullish().catch(undefined),
  /** In a group's stream, the member that waits for the person; anything unreadable is none. */
  waiting_member: waitingMemberShape.nullish().catch(undefined),
});

/** One frame of `GET /v1/conversations/{id}/live`, ready to fold. */
export type SpadeLiveInput =
  | { kind: "stored"; stored: SpadeStored }
  | { kind: "snapshot"; reply: string; text: string }
  /** The backlog is out: everything stored up to `seq` has been sent; what follows is new. */
  | { kind: "caught_up"; seq: number }
  | { kind: "delta"; reply: string; text: string }
  /** The agent's current state and its few words on what it does now (ADR 0127). */
  | {
      kind: "status";
      state: "idle" | "working" | "waiting" | "sleeping" | "paused";
      status: string | undefined;
      /** In a group's stream, the member that waits for the person (by id, never by words). */
      waitingMember?: { id: string; name: string; machine: string | null } | undefined;
    };

/** A live frame by its `event:` name and `data:` text; undefined for names this client skips. */
export function parseSpadeLiveFrame(event: string, data: string): SpadeLiveInput | undefined {
  const body = json(data);
  if (event === "stored") {
    const stored = parseSpadeStored(body);
    return stored && { kind: "stored", stored };
  }
  if (event === "caught_up") {
    const parsed = caughtUpShape.safeParse(body);
    return parsed.success ? { kind: "caught_up", seq: parsed.data.seq } : undefined;
  }
  if (event === "status") {
    const parsed = statusShape.safeParse(body);
    if (!parsed.success) return undefined;
    const input: SpadeLiveInput = {
      kind: "status",
      state: parsed.data.state,
      status: parsed.data.status || undefined,
    };
    if (parsed.data.waiting_member) input.waitingMember = parsed.data.waiting_member;
    return input;
  }
  if (event === "snapshot" || event === "delta") {
    const parsed = replyText.safeParse(body);
    return parsed.success ? { kind: event, ...parsed.data } : undefined;
  }
  return undefined;
}

/** A page of `GET /v1/conversations/{id}/events`; undefined when the body isn't a list. */
export function parseSpadeEvents(body: string): SpadeStored[] | undefined {
  const rows = json(body);
  if (!Array.isArray(rows)) return undefined;
  return rows.flatMap((row) => {
    const stored = parseSpadeStored(row);
    return stored ? [stored] : [];
  });
}

/** `{"error": "..."}`, Spade's refusal body; undefined when there is none. */
const problemShape = z.object({ error: z.string() });

export function spadeProblem(body: string): string | undefined {
  const parsed = problemShape.safeParse(json(body));
  return parsed.success ? parsed.data.error : undefined;
}

/** What a refusal says the request still needs (`client_id`, `ace_account`, …), if it says. */
const needsShape = z.object({ needs: z.string() });

export function spadeProblemNeeds(body: string): string | undefined {
  const parsed = needsShape.safeParse(json(body));
  return parsed.success ? parsed.data.needs : undefined;
}
