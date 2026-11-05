import type { ContentPart } from "@ace/protocol";
import { sanitizeTypedText, sanitizeUserText } from "@ace/native-session/user-text";
import { withoutPortableHandoff } from "@ace/projection";
import { splitAnnotationParts, splitBrowserAnnotations } from "./browser-annotation-parse.ts";
import { tokensFromInput } from "./composer-tokens.ts";
import { extensionDisplayName } from "./extension-names.ts";
import { splitQuoteParts, type ParsedMessageQuote } from "./message-quotes.ts";

/*
 * What the person's bubble shows of a message's parts, decided without I/O: the words as shown
 * (a portable handoff's envelope and browser annotations stay out), and mentions placed among
 * the words as chips. Web and native draw the same content from it.
 */

type Mention = Extract<ContentPart, { type: "mention" }>;

export interface BubbleContent {
  /** The parts left once annotations are taken out. */
  parts: ContentPart[];
  /** The words as shown. */
  text: string;
  /** Whether the bubble has anything to read: words or a mention. */
  readable: boolean;
  annotations: ReturnType<typeof splitAnnotationParts>["annotations"];
  /** Passages of the agent's messages the person commented on. */
  quotes?: ParsedMessageQuote[] | undefined;
}

export function bubbleContent(input: readonly ContentPart[]): BubbleContent {
  // Browser annotations travel as a block after the person's words; they show as a card.
  // Browser annotations and marked passages travel as blocks after the person's words; each
  // shows as a card.
  const annotated = splitAnnotationParts(withoutPortableHandoff(input));
  const quoted = splitQuoteParts(annotated.parts);
  const parts = quoted.parts;
  const text = sanitizeUserText(splitBrowserAnnotations(tokensFromInput(parts).text).text);
  const readable = !!text || parts.some((part) => part.type === "mention");
  return {
    parts,
    text,
    readable,
    annotations: annotated.annotations,
    ...(quoted.quotes ? { quotes: quoted.quotes } : {}),
  };
}

/**
 * A message's words as the person typed them, a leading slash command kept, with what only the
 * agent reads taken out (the daemon's origin marker, context envelopes, browser annotations).
 * For a message still on its way; the transcript's bubble uses `bubbleContent`.
 */
export function typedWords(parts: readonly ContentPart[]): string {
  return sanitizeTypedText(splitBrowserAnnotations(tokensFromInput(parts).text).text);
}

/** A mention's chip name: its title, else its catalog name in words. */
export function mentionName(part: Mention): string {
  return (
    part.title ??
    extensionDisplayName(
      part.name,
      undefined,
      part.kind === "agent" && part.name.includes(":") ? part.name.split(":")[0] : undefined,
    )
  );
}

export type ReferenceSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string; mention: Mention["kind"] };

/**
 * The words of a message with mentions as chips in place. Mentions are kept as opaque markers
 * while the shared sanitizer reads the whole message; the marker is a delimiter absent from the
 * text, so it can't collide with words the person wrote.
 */
export function referenceSegments(parts: readonly ContentPart[]): ReferenceSegment[] {
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  let marker = "ace-reference";
  let delimiter = `${marker}`;
  while (text.includes(delimiter)) {
    marker += marker;
    delimiter = `${marker}`;
  }
  const source = parts
    .map((part, index) =>
      part.type === "text"
        ? part.text
        : part.type === "mention"
          ? `${delimiter}${index}${delimiter}`
          : "",
    )
    .join("");
  const cleaned = source.replace(source.trim(), () => sanitizeUserText(source));
  return cleaned.split(delimiter).flatMap((value, index): ReferenceSegment[] => {
    if (index % 2 === 0) return value ? [{ kind: "text", text: value }] : [];
    const part = parts[Number(value)];
    return part?.type === "mention"
      ? [{ kind: "mention", name: mentionName(part), mention: part.kind }]
      : [];
  });
}
