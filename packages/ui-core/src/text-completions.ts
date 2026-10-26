import type { ForgeIssueDetail, ForgePrDetail } from "@ace/protocol";

/*
 * `@` and `#` completion in a Markdown field, as GitHub reads mentions and references: what the
 * caret is completing, the edit a pick makes, and how a `#` query searches. Pure; the web's
 * editor and the phone's bridge share it.
 */

/** The text a field holds and what is selected in it; `start <= end`, offsets into `value`. */
export interface Selection {
  value: string;
  start: number;
  end: number;
}

/** One edit: replace `from`..`to` with `insert`, then select `select` (offsets in the new text). */
export interface Change {
  from: number;
  to: number;
  insert: string;
  select: readonly [start: number, end: number];
}

/** What is being completed at the caret: a person after `@`, or an issue or PR after `#`. */
export interface CompletionMatch {
  kind: "mention" | "reference";
  /** What was typed after the trigger. */
  query: string;
  /** Where the trigger character is. */
  from: number;
  /** The caret: the end of what is replaced. */
  to: number;
}

const triggers = { "@": "mention", "#": "reference" } as const;
/**
 * What may follow the trigger. A login: letters, digits and dashes. A reference: a number
 * (ended by a space), or title words with single spaces between them ("#retry budg").
 */
const queryChars = {
  mention: /^[\w-]*$/,
  reference: /^(?:\d+|[A-Za-z_.-][\w.-]*(?: [\w.-]+)* ?)?$/,
};

const listItem = /^\s*(?:[-*+]|\d+[.)])\s/;
const indented = /^(?: {4}|\t)/;
/** A blockquote's markers (`> `, `> > `): what follows them is read as its own line. */
const quoteMarkers = /^ {0,3}(?:> ?)+/;

/**
 * Whether the line `at` is on is code as CommonMark reads it, inside blockquotes too: inside a
 * fence (``` or ~~~, at any indent so fences inside list items count, closed only by a fence of
 * the same character at least as long), or an indented code block (four spaces or a tab after
 * a blank line, outside a list, where indentation continues the item instead). A fence line
 * inside an indented code block is that block's text, not a fence.
 */
function inCodeBlock(value: string, at: number): boolean {
  const lines = value
    .slice(0, at)
    .split("\n")
    .map((line) => line.replace(quoteMarkers, ""));
  const current = lines.pop() ?? "";
  let fence: { char: string; length: number } | undefined;
  let afterBlank = true;
  let inList = false;
  let indentedCode = false;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const closes =
        marker?.[1] &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim();
      if (closes) fence = undefined;
      continue;
    }
    const blank = !line.trim();
    indentedCode = !blank && indented.test(line) && !inList && (afterBlank || indentedCode);
    if (!indentedCode && marker?.[1]) {
      fence = { char: marker[1][0] ?? "`", length: marker[1].length };
      continue;
    }
    if (!blank && !indented.test(line)) inList = listItem.test(line);
    afterBlank = blank;
  }
  if (fence) return true;
  return indented.test(current) && !inList && (afterBlank || indentedCode);
}

/**
 * Inside an inline code span on the caret's line: an opening run of backticks (not escaped)
 * with no closing run of the same length before `at`.
 */
function inCodeSpan(value: string, lineStart: number, at: number): boolean {
  const text = value.slice(lineStart, at);
  let open = 0;
  for (const run of text.matchAll(/(\\*)(`+)/g)) {
    const ticks = run[2]?.length ?? 0;
    // Outside a span, an odd number of backslashes escapes the run's first backtick; inside
    // one, a backslash is just text (CommonMark), so it can't keep the span from closing.
    const escaped = !open && (run[1]?.length ?? 0) % 2 === 1;
    const length = escaped ? ticks - 1 : ticks;
    if (!length) continue;
    if (!open) open = length;
    else if (length === open) open = 0;
  }
  return open > 0;
}

/**
 * The `@` or `#` word the caret ends, if any. The trigger starts a word (line start, after a
 * space or an opening bracket), as GitHub reads mentions; email addresses, `a#b`, code and a
 * selection never complete. `#` after a line's opening hashes is a heading, not a reference.
 */
export function completionAt(selection: Selection): CompletionMatch | undefined {
  const { value, start, end } = selection;
  if (start !== end) return undefined;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const before = value.slice(lineStart, start);
  const at = Math.max(before.lastIndexOf("@"), before.lastIndexOf("#"));
  if (at < 0) return undefined;
  const trigger = before[at];
  if (trigger !== "@" && trigger !== "#") return undefined;
  const kind = triggers[trigger];
  const query = before.slice(at + 1);
  if (query.length > 60 || !queryChars[kind].test(query)) return undefined;
  const previous = at === 0 ? "" : (before[at - 1] ?? "");
  if (previous && !/[\s([{]/.test(previous)) return undefined;
  // `[text](#anchor)` and `[text](@x)` are a link's target, not a reference or a mention.
  if (before.slice(Math.max(0, at - 2), at) === "](") return undefined;
  if (kind === "reference" && /^\s*#*$/.test(before.slice(0, at))) {
    // "#" opening a line is a heading unless a word already follows it ("#12", "#fix").
    if (query === "" || before.slice(0, at).trim() !== "") return undefined;
  }
  const from = lineStart + at;
  if (inCodeBlock(value, from) || inCodeSpan(value, lineStart, from)) return undefined;
  return { kind, query, from, to: start };
}

/**
 * Replace the whole trigger word with `text` and a space, leaving the caret after the space:
 * picked with the caret mid-word (`@mi|ra`), the rest of the word goes too. A space already
 * following the word is reused rather than doubled.
 */
export function completionChange(
  selection: Selection,
  match: CompletionMatch,
  text: string,
): Change {
  const tail = (match.kind === "mention" ? /^[\w-]*/ : /^[\w.-]*/).exec(
    selection.value.slice(match.to),
  );
  const to = match.to + (tail?.[0].length ?? 0);
  const spaced = /^\s/.test(selection.value.slice(to, to + 1));
  const insert = spaced ? text : `${text} `;
  const caret = match.from + insert.length + (spaced ? 1 : 0);
  return { from: match.from, to, insert, select: [caret, caret] };
}

/**
 * What a `#` query sends to a search that matches whole words only (GitHub's): a number as
 * typed (looked up exactly), else the words already finished. The word still being typed is
 * left out, so `#daem` asks for recent items and `#daemon forg` for `daemon`; `referenceMatches`
 * then narrows the answer by what is typed.
 */
export function referenceSearch(query: string): string {
  const trimmed = query.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const words = query.split(" ").filter(Boolean);
  if (!query.endsWith(" ")) words.pop();
  return words.join(" ");
}

/**
 * A reference fits a `#` query when its number starts with the digits typed, or every typed
 * word starts some word of its title (the last one may still be half typed).
 */
export function referenceMatches(
  reference: { number: number; title: string },
  query: string,
): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  if (/^\d+$/.test(trimmed)) return String(reference.number).startsWith(trimmed);
  const titleWords = reference.title
    .toLowerCase()
    .split(/[^\w.-]+/)
    .filter(Boolean);
  return trimmed
    .split(" ")
    .filter(Boolean)
    .every((word) => titleWords.some((titleWord) => titleWord.startsWith(word)));
}

/** Someone `@` can name. */
export interface CompletionPerson {
  login: string;
  name?: string | undefined;
  avatarUrl?: string | undefined;
}

/** How many suggestions a list shows. */
const most = 8;

/**
 * A search as the protocol accepts it (`ForgeCompletionQuery`): anything else becomes a space,
 * so `acme/docs` searches `acme docs` and no search qualifier reaches GitHub. The one sanitizer
 * before the wire.
 */
export function searchable(query: string): string {
  return query
    .replace(/[^\w .-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function matches(person: CompletionPerson, query: string): boolean {
  const q = query.toLowerCase();
  return (
    !q ||
    person.login.toLowerCase().includes(q) ||
    (person.name?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * `@` suggestions in GitHub's order: the conversation's own people first (in the order given),
 * then the repository's others, each person once.
 */
export function rankPeople(
  participants: readonly CompletionPerson[],
  found: readonly CompletionPerson[],
  query: string,
): CompletionPerson[] {
  const seen = new Map<string, CompletionPerson>();
  for (const person of [...participants.filter((p) => matches(p, query)), ...found]) {
    const key = person.login.toLowerCase();
    const known = seen.get(key);
    // A search result may know the name and picture a participant's entry lacks.
    seen.set(
      key,
      known
        ? {
            ...person,
            ...known,
            name: known.name ?? person.name,
            avatarUrl: known.avatarUrl ?? person.avatarUrl,
          }
        : person,
    );
  }
  return [...seen.values()].slice(0, most);
}

function people(entries: readonly (readonly [string, string | undefined])[]): CompletionPerson[] {
  const seen = new Set<string>();
  return entries.flatMap(([login, avatarUrl]) => {
    const key = login.toLowerCase();
    if (!login || seen.has(key)) return [];
    seen.add(key);
    return [{ login, ...(avatarUrl ? { avatarUrl } : {}) }];
  });
}

/** A pull request's people: its author, reviewers, then whoever commented, latest first. */
export function prParticipants(detail: ForgePrDetail): CompletionPerson[] {
  const comments = detail.status.comments.toSorted((a, b) =>
    (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt),
  );
  return people([
    [detail.author, detail.authorAvatarUrl],
    ...detail.reviewers.map((login) => [login, detail.reviewerAvatars?.[login]] as const),
    ...comments.map((c) => [c.author, c.authorAvatarUrl] as const),
  ]);
}

/** An issue's people: its author, assignees, then whoever spoke in it, latest first. */
export function issueParticipants(
  issue: ForgeIssueDetail,
  actors: readonly string[],
): CompletionPerson[] {
  return people([
    [issue.author, issue.authorAvatarUrl ?? issue.avatars?.[issue.author]],
    ...issue.assignees.map((login) => [login, issue.avatars?.[login]] as const),
    ...actors.toReversed().map((login) => [login, issue.avatars?.[login]] as const),
  ]);
}
