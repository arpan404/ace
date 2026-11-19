import type { ThreadListEntry } from "@ace/protocol";

/**
 * Whether a listed thread matches what the person typed in a panel's search: every word must
 * match, case aside, its title, its project's name, its branch or a linked pull request's number
 * ("#1536" or "1536"). A word matches where it appears anywhere; and, so the search needn't be
 * exact, a word of three letters or more also matches a word it abbreviates in order from the
 * same first letter ("pgntn" → "pagination"), and one of four letters or more one typo away
 * from a word or the start of one ("paginaton", "sidbear"). An empty query matches everything.
 */
export function threadMatches(
  entry: Pick<ThreadListEntry, "title" | "details">,
  query: string,
  projectName: string,
): boolean {
  const typed = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!typed.length) return true;
  const details = entry.details;
  const prs = [
    ...(details?.linkedPrs?.map((pr) => pr.number) ?? []),
    ...(details?.linkedPr ? [details.linkedPr.number] : []),
  ];
  const haystack = [
    entry.title,
    projectName,
    details?.branch ?? "",
    ...prs.map((number) => `#${number}`),
  ]
    .join("\n")
    .toLowerCase();
  const words = haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return typed.every((word) => haystack.includes(word) || words.some((w) => near(word, w)));
}

/** `typed` abbreviates `word`, or is one typo from it or from its start. */
function near(typed: string, word: string): boolean {
  if (typed.length >= 3 && typed[0] === word[0] && abbreviates(typed, word)) return true;
  if (typed.length < 4) return false;
  // Against the whole word, and against its start (the person may still be typing).
  return oneEditApart(typed, word) || oneEditApart(typed, word.slice(0, typed.length));
}

/** Every letter of `typed` appears in `word`, in order. */
function abbreviates(typed: string, word: string): boolean {
  let at = 0;
  for (const letter of word) if (letter === typed[at]) at++;
  return at === typed.length;
}

/** At most one letter added, dropped, changed, or two neighbours swapped. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    const rest = (n: number) => a.slice(i + n) === b.slice(i + n);
    // Changed here, or swapped with the next.
    return rest(1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(2));
  }
  // One longer: drop its letter here.
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
