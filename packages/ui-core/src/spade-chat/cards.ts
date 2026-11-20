import { z } from "zod";
import type { SpadeImageRef } from "./media.ts";

/*
 * Cards a bot shows (ADR 0200 §5.1, spade/docs/runtime.md): typed data that every client draws
 * with ace's own parts, never a page. Spade checked the card against its blocks' rules before it
 * stored it; this reads it leniently, as every event is read: a block of a kind this client
 * doesn't know is kept as raw data and left undrawn, and the rest of the card still shows. Shared
 * by every client, the iPhone included, so each draws the same card from the same data.
 */

export interface SpadeCardField {
  label: string;
  value: string;
}

/** An action, of a fixed kind: `choose` sends its label back to the bot; `open` opens a link. */
export type SpadeCardAction =
  | { kind: "choose"; id: string; label: string }
  | { kind: "open"; label: string; url: string; host: string };

export type SpadeCardBlock =
  | { kind: "fields"; rows: readonly SpadeCardField[] }
  | { kind: "metric"; label: string; value: string; unit?: string; change?: string }
  | { kind: "progress"; label?: string; value: number; max: number }
  | { kind: "table"; columns: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: "list"; items: readonly string[]; ordered: boolean }
  | { kind: "image"; image: SpadeImageRef; alt: string }
  | { kind: "link"; url: string; host: string; label?: string }
  | { kind: "actions"; actions: readonly SpadeCardAction[] }
  /** A block of a kind a later Spade draws: kept as it came, left out here. */
  | { kind: "unknown"; raw: unknown };

export interface SpadeCard {
  title: string;
  blocks: readonly SpadeCardBlock[];
}

const words = z.string();
const optional = z
  .string()
  .nullish()
  .catch(undefined)
  .transform((value) => value || undefined);
/** An https address, as Spade checked it; anything else is no link at all. */
const https = z.string().refine((url) => url.startsWith("https://"));

const imageRef = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  media_type: z.string().catch("image/png").default("image/png"),
  bytes: z.number().int().nonnegative().catch(0).default(0),
});

const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choose"), id: words, label: words }),
  z.object({ kind: z.literal("open"), label: words, url: https, host: words }),
]);

const block = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fields"),
    rows: z.array(z.object({ label: words, value: words })),
  }),
  z.object({
    kind: z.literal("metric"),
    label: words,
    value: words,
    unit: optional,
    change: optional,
  }),
  z.object({
    kind: z.literal("progress"),
    label: optional,
    value: z.number(),
    max: z.number().positive(),
  }),
  z.object({
    kind: z.literal("table"),
    columns: z.array(words),
    rows: z.array(z.array(words)),
  }),
  z.object({
    kind: z.literal("list"),
    items: z.array(words),
    ordered: z.boolean().catch(false).default(false),
  }),
  z.object({ kind: z.literal("image"), image: imageRef, alt: words.catch("") }),
  z.object({ kind: z.literal("link"), url: https, host: words, label: optional }),
  z.object({
    kind: z.literal("actions"),
    // An action this client can't read is left out; the others still work.
    actions: z.array(z.unknown()).transform((list) =>
      list.flatMap((item) => {
        const parsed = action.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  }),
]);

function readBlock(raw: unknown): SpadeCardBlock {
  const parsed = block.safeParse(raw);
  if (!parsed.success) return { kind: "unknown", raw };
  const value = parsed.data;
  switch (value.kind) {
    case "image":
      return {
        kind: "image",
        alt: value.alt,
        image: {
          sha256: value.image.sha256,
          mediaType: value.image.media_type,
          bytes: value.image.bytes,
        },
      };
    case "metric":
      return {
        kind: "metric",
        label: value.label,
        value: value.value,
        ...(value.unit ? { unit: value.unit } : {}),
        ...(value.change ? { change: value.change } : {}),
      };
    case "progress":
      return {
        kind: "progress",
        value: Math.min(Math.max(value.value, 0), value.max),
        max: value.max,
        ...(value.label ? { label: value.label } : {}),
      };
    case "link":
      return {
        kind: "link",
        url: value.url,
        host: value.host,
        ...(value.label ? { label: value.label } : {}),
      };
    default:
      return value;
  }
}

const cardShape = z.object({
  title: words,
  blocks: z.array(z.unknown()).nullish().catch(undefined),
});

/** A stored card's data; undefined when it has no title to draw. */
export function parseSpadeCard(raw: unknown): SpadeCard | undefined {
  const parsed = cardShape.safeParse(raw);
  if (!parsed.success || !parsed.data.title.trim()) return undefined;
  return { title: parsed.data.title, blocks: (parsed.data.blocks ?? []).map(readBlock) };
}

/** The card's `choose` actions, the ones that come back to the bot. */
export function spadeCardChoices(card: SpadeCard): readonly { id: string; label: string }[] {
  return card.blocks.flatMap((b) =>
    b.kind === "actions"
      ? b.actions.flatMap((a) => (a.kind === "choose" ? [{ id: a.id, label: a.label }] : []))
      : [],
  );
}

/** A card as the chat shows it: its latest version, and the choice made on that version. */
export interface SpadeCardRow {
  /** The card's id, the same across versions. */
  cardId: string;
  version: number;
  card: SpadeCard;
  /** The choice the person pressed on this version, once Spade stored it. */
  chosen: { action: string; label: string } | undefined;
  /** The turn had read untrusted content when the bot made it. */
  untrusted: boolean;
}

/** The stored events `wire.ts` reads for cards, `spade_core::card` as it writes them. */
export const spadeCardEvents = [
  z.object({
    type: z.literal("card_shown"),
    reply: z.string().catch(""),
    call_id: z.string().catch(""),
    card: z.string().min(1),
    version: z.number().int().positive(),
    data: z.unknown(),
    untrusted: z.boolean().catch(false).default(false),
  }),
  z.object({
    type: z.literal("card_action"),
    card: z.string().min(1),
    version: z.number().int().positive(),
    action: z.string(),
    label: z.string().catch(""),
  }),
] as const;

/** The row for a newly stored version of a card; undefined when its data can't be drawn. */
export function spadeCardShown(event: {
  card: string;
  version: number;
  data: unknown;
  untrusted: boolean;
}): SpadeCardRow | undefined {
  const card = parseSpadeCard(event.data);
  return (
    card && {
      cardId: event.card,
      version: event.version,
      card,
      chosen: undefined,
      untrusted: event.untrusted,
    }
  );
}

/** The row once the person chose on it; undefined when the choice was on an older version. */
export function spadeCardChosen(
  row: SpadeCardRow,
  event: { version: number; action: string; label: string },
): SpadeCardRow | undefined {
  if (row.version !== event.version || row.chosen) return undefined;
  return { ...row, chosen: { action: event.action, label: event.label } };
}
