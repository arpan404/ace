import { z } from "zod";

/*
 * A bot's personality: how it talks (tone, humour, emoji), set in its profile or brought by a
 * template or a marketplace recipe. Spade puts it in the bot's standing instructions as a section
 * of its own, from the next turn; it changes only style, never the task. Humour and emoji are off
 * unless chosen. Pure, so every client reads and words it the same.
 */

export type SpadeTone = "concise" | "warm" | "formal" | "playful";

export interface SpadePersonality {
  /** Undefined leaves the manner to the bot. */
  tone: SpadeTone | undefined;
  humour: boolean;
  emoji: boolean;
}

/** The tones, in the order the profile offers them, each with what it means. */
export const spadeTones: readonly { value: SpadeTone; label: string; says: string }[] = [
  { value: "concise", label: "Concise", says: "Short sentences, the answer first" },
  { value: "warm", label: "Warm", says: "Friendly and encouraging" },
  { value: "formal", label: "Formal", says: "Precise and professional" },
  { value: "playful", label: "Playful", says: "Light, still clear" },
];

/** A new personality: no tone chosen, no humour, no emoji. */
export const spadeQuietPersonality: SpadePersonality = {
  tone: undefined,
  humour: false,
  emoji: false,
};

const shape = z.object({
  tone: z.enum(["concise", "warm", "formal", "playful"]).nullish().catch(undefined),
  humour: z.boolean().catch(false).default(false),
  emoji: z.boolean().catch(false).default(false),
});

/** A personality as Spade sent it (an agent's, a template's, a recipe's); undefined when unset. */
export function parseSpadePersonality(raw: unknown): SpadePersonality | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = shape.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    tone: parsed.data.tone ?? undefined,
    humour: parsed.data.humour,
    emoji: parsed.data.emoji,
  };
}

/** The body `PATCH /v1/agents/{id}` takes for it. */
export function spadePersonalityBody(personality: SpadePersonality): Record<string, unknown> {
  return {
    ...(personality.tone ? { tone: personality.tone } : {}),
    humour: personality.humour,
    emoji: personality.emoji,
  };
}

/** One line of how it talks: "Concise, no jokes, no emoji", "Warm, with humour and emoji". */
export function spadePersonalityWords(personality: SpadePersonality): string {
  const tone = spadeTones.find((option) => option.value === personality.tone)?.label;
  const extras =
    personality.humour && personality.emoji
      ? "with humour and emoji"
      : personality.humour
        ? "with humour, no emoji"
        : personality.emoji
          ? "no jokes, with emoji"
          : "no jokes, no emoji";
  return tone ? `${tone}, ${extras}` : extras.charAt(0).toUpperCase() + extras.slice(1);
}
