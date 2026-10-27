import type {
  BrowserTabContextItem,
  CatalogEntry,
  CatalogMention,
  ContentPart,
  Mention,
  MessageContextItem,
  ThreadRefContextItem,
} from "@ace/protocol";

/** Offsets use the draft's plain text, including each reference's visible name. */
export interface ComposerToken {
  start: number;
  end: number;
  label: string;
  catalog?: CatalogMention | undefined;
  file?: Mention | undefined;
  thread?: ThreadRefContextItem | undefined;
  /** A tab of the thread's browser (`@` a tab). */
  browserTab?: BrowserTabContextItem | undefined;
}

/** An edit touching a reference removes it; edits around it preserve its position. */
export function editComposerTokens(
  before: string,
  after: string,
  tokens: readonly ComposerToken[],
): readonly ComposerToken[] {
  if (!tokens.length || before === after) return tokens;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const delta = nextEnd - end;
  const next = tokens.flatMap((token) => {
    if (token.end <= start) return [token];
    if (token.start >= end)
      return [{ ...token, start: token.start + delta, end: token.end + delta }];
    return [];
  });
  return next.length === tokens.length && next.every((token, index) => token === tokens[index])
    ? tokens
    : next;
}

export function composerInput(text: string, tokens: readonly ComposerToken[]): ContentPart[] {
  const parts: ContentPart[] = [];
  let at = 0;
  for (const token of tokens) {
    if (!token.catalog) continue;
    if (token.start > at) parts.push({ type: "text", text: text.slice(at, token.start) });
    parts.push(token.catalog);
    at = token.end;
  }
  if (at < text.length) parts.push({ type: "text", text: text.slice(at) });
  return parts.length ? parts : [{ type: "text", text }];
}

/**
 * What a message's references add to its context: the threads and browser tabs it points at,
 * and its files (`also`, files written as `@path` without a reference, first), each file once.
 */
export function referenceContext(
  tokens: readonly ComposerToken[],
  also: readonly Mention[] = [],
): { items: MessageContextItem[]; mentions: Mention[] } {
  const files = tokens.flatMap((token) => (token.file ? [token.file] : []));
  const mentions = [
    ...also.filter((mention) => !files.some((file) => file.path === mention.path)),
    ...files,
  ].filter(
    (mention, index, all) =>
      all.findIndex(
        (other) =>
          other.path === mention.path &&
          JSON.stringify(other.lines) === JSON.stringify(mention.lines),
      ) === index,
  );
  return {
    items: tokens.flatMap((token): MessageContextItem[] =>
      token.thread ? [token.thread] : token.browserTab ? [token.browserTab] : [],
    ),
    mentions,
  };
}

/**
 * A message typed as `/name ...` without picking from the menu still selects the catalog
 * entry of that exact name, so the daemon can invoke it instead of sending bare slash text.
 * Entries that need a client action or a parameter form, and unknown names, stay as text.
 */
export function withTypedCommand(
  text: string,
  tokens: readonly ComposerToken[],
  entries: readonly CatalogEntry[] | undefined,
): readonly ComposerToken[] {
  const typed = /^\/([^\s/]+)(?=\s|$)/.exec(text);
  if (!typed || !entries || tokens.some((token) => token.start < typed[0].length)) return tokens;
  const entry = entries.find(
    (candidate) =>
      candidate.name === typed[1] &&
      candidate.kind !== "builtin" &&
      candidate.invocation.type !== "unavailable" &&
      candidate.invocation.type !== "action" &&
      !(
        candidate.invocation.type === "prompt" &&
        Object.keys(candidate.invocation.parameters ?? {}).length
      ),
  );
  if (!entry) return tokens;
  const catalog: CatalogMention = {
    type: "mention",
    entryId: entry.id,
    name: entry.name,
    kind: entry.kind,
    ...(entry.icon ? { icon: entry.icon } : {}),
    arguments: "",
  };
  return [{ start: 0, end: typed[0].length, label: typed[0], catalog }, ...tokens];
}

/** Recover references when editing a failed send. */
export function tokensFromInput(input: readonly ContentPart[]): {
  text: string;
  tokens: ComposerToken[];
} {
  let text = "";
  const tokens: ComposerToken[] = [];
  for (const part of input) {
    if (part.type === "text") text += part.text;
    if (part.type === "mention") {
      const label = part.name;
      tokens.push({ start: text.length, end: text.length + label.length, label, catalog: part });
      text += label;
    }
  }
  return { text, tokens };
}

/**
 * A sent or queued message's input with new words: its `@` mentions and catalog picks follow the
 * edit as the composer's do, and its files and images stay. Pure.
 */
export function inputWithText(input: readonly ContentPart[], text: string): ContentPart[] {
  const original = tokensFromInput(input);
  return [
    ...composerInput(text, editComposerTokens(original.text, text, original.tokens)),
    ...input.filter((part) => part.type !== "text" && part.type !== "mention"),
  ];
}
