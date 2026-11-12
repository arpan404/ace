import { z } from "zod";

/*
 * Spade's own bodies, as its local API writes them (spade/docs/chat-core.md, harness.md). The
 * daemon passes them through as text, so every client parses them here, leniently: an event
 * type this client doesn't know is kept as raw data, a field it doesn't know is ignored.
 */

const text = z.string();
const reply = z.string();

/** An image the person attached, stored by Spade under its hash. */
const imageRef = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  media_type: z.string().default("image/png"),
  bytes: z.number().int().nonnegative().default(0),
});
export interface SpadeImageRef {
  sha256: string;
  mediaType: string;
  bytes: number;
}

/** The stored event types the person's view reads. Anything else is kept as `unknown`. */
const known = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    text: text.default(""),
    // An image this client can't read is left out; the message still shows.
    images: z
      .array(z.unknown())
      .optional()
      .default([])
      .transform((images) =>
        images.flatMap((image): SpadeImageRef[] => {
          const parsed = imageRef.safeParse(image);
          return parsed.success
            ? [
                {
                  sha256: parsed.data.sha256,
                  mediaType: parsed.data.media_type,
                  bytes: parsed.data.bytes,
                },
              ]
            : [];
        }),
      ),
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
  }),
  z.object({ type: z.literal("reply_interrupted"), reply, text: text.default("") }),
  z.object({
    type: z.literal("approval_requested"),
    reply,
    call_id: z.string(),
    name: z.string(),
    arguments: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("approval_answered"),
    reply,
    call_id: z.string(),
    allowed: z.boolean(),
    always: z.boolean().optional(),
  }),
  z.object({ type: z.literal("tool_started"), reply, call_id: z.string(), name: z.string() }),
  z.object({
    type: z.literal("tool_finished"),
    reply,
    call_id: z.string(),
    name: z.string(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.literal("job_started"), reply, job: z.string(), name: z.string() }),
  z.object({
    type: z.literal("job_finished"),
    job: z.string(),
    name: z.string(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.literal("context_compacted") }),
  z.object({
    type: z.literal("stop_requested"),
    reply: z.string().nullish(),
    jobs: z.array(z.string()).optional().default([]),
  }),
  z.object({ type: z.literal("renamed"), title: z.string() }),
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

/** One frame of `GET /v1/conversations/{id}/live`, ready to fold. */
export type SpadeLiveInput =
  | { kind: "stored"; stored: SpadeStored }
  | { kind: "snapshot"; reply: string; text: string }
  /** The backlog is out: everything stored up to `seq` has been sent; what follows is new. */
  | { kind: "caught_up"; seq: number }
  | { kind: "delta"; reply: string; text: string };

function json(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

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

/** A row of `GET /v1/conversations`. */
export interface SpadeConversationRow {
  id: string;
  title: string;
  updatedAt: number;
  answering: boolean;
  /** Background jobs still running. */
  jobs: number;
  /** An approval waits on the person. */
  waitingOnYou: boolean;
  /**
   * The client key of the start that made it; null when it had none. Undefined from a Spade older
   * than keys, which lists none.
   */
  clientKey: string | null | undefined;
}

const conversationRow = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  updated_at: z.number().default(0),
  answering: z.boolean().default(false),
  jobs: z.number().int().nonnegative().default(0),
  waiting_on_you: z.boolean().default(false),
  client_key: z.string().nullish().catch(null),
});

/** The conversation list, newest first as Spade sends it; a row it can't read is left out. */
export function parseSpadeConversations(body: string): SpadeConversationRow[] | undefined {
  const rows = json(body);
  if (!Array.isArray(rows)) return undefined;
  return rows.flatMap((row) => {
    const parsed = conversationRow.safeParse(row);
    if (!parsed.success) return [];
    const { id, title, updated_at, answering, jobs, waiting_on_you, client_key } = parsed.data;
    return [
      {
        id,
        title: title ?? "",
        updatedAt: updated_at,
        answering,
        jobs,
        waitingOnYou: waiting_on_you,
        clientKey: client_key,
      },
    ];
  });
}

const modelsShape = z.object({
  endpoints: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullish(),
        format: z.string().nullish(),
        needs_key: z.boolean().default(false),
        key_set: z.boolean().default(false),
        key_source: z.string().nullish(),
        models: z.array(z.object({ id: z.string(), name: z.string().nullish() })).default([]),
      }),
    )
    .default([]),
  roles: z.record(z.string(), z.string().nullish()).default({}),
  keychain: z.boolean().default(false),
});

export interface SpadeEndpoint {
  id: string;
  name: string;
  needsKey: boolean;
  keySet: boolean;
  /** Where the key in use comes from: only a keychain key can be removed from here. */
  keySource: "keychain" | "environment" | undefined;
  models: { id: string; name: string }[];
}

/** `GET /v1/models`: Spade's endpoints, its role picks and whether this machine has a keychain. */
export interface SpadeModels {
  endpoints: SpadeEndpoint[];
  /** The model id each role uses (`main`, `fast`, `deep`). */
  roles: Record<string, string>;
  keychain: boolean;
}

export function parseSpadeModels(body: string): SpadeModels | undefined {
  const parsed = modelsShape.safeParse(json(body));
  if (!parsed.success) return undefined;
  const roles: Record<string, string> = {};
  for (const [role, model] of Object.entries(parsed.data.roles)) if (model) roles[role] = model;
  return {
    endpoints: parsed.data.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name || endpoint.id,
      needsKey: endpoint.needs_key,
      keySet: endpoint.key_set,
      keySource:
        endpoint.key_source === "keychain" || endpoint.key_source === "environment"
          ? endpoint.key_source
          : undefined,
      models: endpoint.models.map((model) => ({ id: model.id, name: model.name || model.id })),
    })),
    roles,
    keychain: parsed.data.keychain,
  };
}

/** `{"error": "..."}`, Spade's refusal body; undefined when there is none. */
const problemShape = z.object({ error: z.string() });
const createdShape = z.object({ id: z.string().min(1) });

export function spadeProblem(body: string): string | undefined {
  const parsed = problemShape.safeParse(json(body));
  return parsed.success ? parsed.data.error : undefined;
}

/** `201 {id}` from starting a conversation. */
export function parseSpadeCreated(body: string): string | undefined {
  const parsed = createdShape.safeParse(json(body));
  return parsed.success ? parsed.data.id : undefined;
}
