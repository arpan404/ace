/*
 * Emoji drawn the same on every OS: Twemoji's SVGs (jdecked/twemoji, via @twemoji/svg), found by
 * codepoint. Pure helpers here; `components/emoji.tsx` draws them.
 */

/** Twemoji's file name for an emoji: its codepoints in hex, joined by `-`, with the variation
 * selector dropped unless a zero-width joiner makes it a sequence. */
export function emojiFile(emoji: string): string {
  const points = [...emoji].map((char) => char.codePointAt(0) ?? 0);
  const joined = points.includes(0x200d);
  return points
    .filter((point) => joined || point !== 0xfe0f)
    .map((point) => point.toString(16))
    .join("-");
}

/** The pictographs in a line of words: text and emoji in order, for drawing the emoji as images. */
const pictograph =
  /(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?(?:‍\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?)*)/gu;

export type EmojiPart = { kind: "text" | "emoji"; text: string };

export function splitEmoji(text: string): EmojiPart[] {
  const parts: EmojiPart[] = [];
  let from = 0;
  for (const match of text.matchAll(pictograph)) {
    // A bare digit or `#` is a character, not an emoji, unless it is a keycap.
    if (match[0].length < 2 && !/\p{Extended_Pictographic}/u.test(match[0])) continue;
    if (match.index > from) parts.push({ kind: "text", text: text.slice(from, match.index) });
    parts.push({ kind: "emoji", text: match[0] });
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push({ kind: "text", text: text.slice(from) });
  return parts;
}
