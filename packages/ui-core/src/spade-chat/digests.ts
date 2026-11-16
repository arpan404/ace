import { z } from "zod";
import { spadeJson } from "./json.ts";
import { spadeMoney } from "./oversight.ts";

/*
 * Digests (ADR 0165): what a bot's work came to over a window, built by Spade from its events
 * with no model call, listed at `GET /v1/digests`. The chat shows each as a message from the bot,
 * timed like a routine's run, never in the conversation's own events (the bot never reads it).
 * A maker's digest has one line per worker; spend is plain information.
 */

const words = z.string().catch("").default("");
const count = z.number().int().nonnegative().catch(0).default(0);
const list = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((rows) =>
      rows.flatMap((row) => {
        const parsed = item.safeParse(row);
        return parsed.success ? [parsed.data as z.output<T>] : [];
      }),
    );

const progress = z.object({
  title: words,
  state: z.enum(["none", "working", "checking", "not_yet", "unchecked", "done"]).catch("working"),
  items_total: count,
  items_verified: count,
});

interface DigestBody {
  agent: string;
  name: string;
  quiet: boolean;
  progress?: z.output<typeof progress> | undefined;
  changed: { text: string }[];
  more_changed: number;
  decisions: { choice: string }[];
  spend: { total_micros: number };
  next: string[];
  waiting: { what: string }[];
  workers: DigestBody[];
  subtree_spend_micros: number;
}

const body: z.ZodType<DigestBody> = z.lazy(() =>
  z.object({
    agent: words,
    name: words,
    quiet: z.boolean().catch(false).default(false),
    progress: progress.optional().catch(undefined),
    changed: list(z.object({ text: z.string() })),
    more_changed: count,
    decisions: list(z.object({ choice: z.string() })),
    spend: z
      .object({ total_micros: count })
      .catch({ total_micros: 0 })
      .default({ total_micros: 0 }),
    next: list(z.string()),
    waiting: list(z.object({ what: z.string() })),
    workers: list(body),
    subtree_spend_micros: count,
  }),
);

const row = z.object({
  id: z.string(),
  agent: z.string(),
  made_ms: z.number(),
  /** The plain rendering (or its polish): what shows when the digest itself can't be read. */
  text: words,
  polished: z.string().nullish().catch(undefined),
  digest: body.optional().catch(undefined),
});

/** One digest as the chat reads it. */
export interface SpadeDigest {
  id: string;
  agent: string;
  /** When Spade made it: where it sits in the chat. */
  at: number;
  text: string;
  body: DigestBody | undefined;
}

/** `GET /v1/digests`, oldest first; undefined when the body isn't a list of them. */
export function parseSpadeDigests(text: string): SpadeDigest[] | undefined {
  const parsed = z.object({ digests: z.array(z.unknown()) }).safeParse(spadeJson(text));
  if (!parsed.success) return undefined;
  return parsed.data.digests
    .flatMap((raw) => {
      const one = row.safeParse(raw);
      if (!one.success) return [];
      const { id, agent, made_ms, text: plain, polished, digest } = one.data;
      return [{ id, agent, at: made_ms, text: polished?.trim() || plain, body: digest }];
    })
    .toSorted((a, b) => a.at - b.at);
}

/** A digest as its message reads. */
export interface SpadeDigestMessage {
  /** "Get #2081 merged · 4 of 6 verified"; undefined with no goal. */
  heading: string | undefined;
  /** What changed, what waits on the person, what it decided for them. */
  lines: readonly string[];
  /** One line per worker, under the maker's own part: its name, then `line` (" is done, …"). */
  workers: readonly { agent: string; name: string; line: string }[];
  /** "Spent $3.96 across the team. Next: rerun Linux CI." Empty when there is neither. */
  close: string;
  /** Spade's plain text, for a digest whose parts couldn't be read. */
  plain: string | undefined;
}

/** The most lines of what changed a message lists; the rest are counted. */
const mostChanged = 5;

const verified = (p: z.output<typeof progress>) =>
  p.items_total ? `${p.items_verified} of ${p.items_total} verified` : "";

const workerState: Record<z.output<typeof progress>["state"], string> = {
  none: "",
  working: "is working on it",
  checking: "is being checked",
  not_yet: "isn’t done yet",
  unchecked: "says done, not checked",
  done: "is done",
};

export function spadeDigestMessage(digest: SpadeDigest): SpadeDigestMessage {
  const own = digest.body;
  if (!own) return { heading: undefined, lines: [], workers: [], close: "", plain: digest.text };
  const goal = own.progress && own.progress.state !== "none" ? own.progress : undefined;
  const more = own.more_changed + Math.max(0, own.changed.length - mostChanged);
  const lines = [
    ...own.changed.slice(0, mostChanged).map((line) => line.text),
    ...(more ? [`and ${more} more`] : []),
    ...own.waiting.map((waiting) => `Waits on you: ${waiting.what}`),
    ...own.decisions.map((decision) => `Decided for you: ${decision.choice}`),
  ];
  const workers = own.workers.map((worker) => {
    const p = worker.progress && worker.progress.state !== "none" ? worker.progress : undefined;
    const state = p ? [workerState[p.state], verified(p)].filter(Boolean).join(", ") : "";
    return {
      agent: worker.agent,
      name: worker.name,
      line: state
        ? ` ${state}`
        : `: ${worker.changed[0]?.text ?? (worker.quiet ? "nothing new" : "worked on it")}`,
    };
  });
  const spent = own.workers.length ? own.subtree_spend_micros : own.spend.total_micros;
  const close = [
    spent > 0 ? `Spent ${spadeMoney(spent)}${own.workers.length ? " across the team" : ""}.` : "",
    own.next[0] ? `Next: ${own.next[0]}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replaceAll("..", ".");
  return {
    heading: goal ? [goal.title, verified(goal)].filter(Boolean).join(" · ") : undefined,
    lines,
    workers,
    close,
    plain: !goal && !lines.length && !workers.length && !close ? digest.text : undefined,
  };
}

/** A digest in the chat: its time line names it (`routine`), then its message. */
export type SpadeDigestItem =
  | { kind: "routine"; key: string; name: string; label: string; at: number }
  | { kind: "digest"; key: string; digest: SpadeDigest; at: number };

/**
 * The chat's items with each digest where it was made: after everything said before it, before
 * the first thing said after. Both lists are in time order, so one pass places them all.
 */
export function withSpadeDigests<T extends object>(
  items: readonly T[],
  digests: readonly SpadeDigest[],
): (T | SpadeDigestItem)[] {
  if (!digests.length) return [...items];
  const out: (T | SpadeDigestItem)[] = [];
  let next = 0;
  const place = (upTo: number) => {
    for (let digest = digests[next]; digest && digest.at <= upTo; digest = digests[++next]) {
      out.push({
        kind: "routine",
        key: `digest-time:${digest.id}`,
        name: "Digest",
        label: "",
        at: digest.at,
      });
      out.push({ kind: "digest", key: `digest:${digest.id}`, digest, at: digest.at });
    }
  };
  for (const item of items) {
    const at = "at" in item ? item.at : undefined;
    if (typeof at === "number" && at > 0) place(at - 1);
    out.push(item);
  }
  place(Infinity);
  return out;
}
