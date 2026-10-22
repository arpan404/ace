/*
 * What GitHub links or draws inside plain text of PR and issue text (ADR 0096): emoji shortcodes
 * (`:tada:`), @mentions of people and teams, `#123` references, and footnote markers (`[^1]`).
 * Pure: the caller says which shortcodes and footnotes exist, and draws the segments.
 */

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "emoji"; emoji: string; code: string }
  | { kind: "mention"; login: string; team?: string | undefined; text: string }
  | { kind: "reference"; number: number; text: string }
  | { kind: "footnote"; label: string; number: number };

const pattern = new RegExp(
  [
    ":(?<emoji>[a-z0-9_+-]{1,64}):",
    "\\[\\^(?<footnote>[^\\]\\s]{1,64})\\]",
    // A login: letters, digits and single hyphens; not inside an email address or a path.
    "(?<![\\w@/.`])@(?<login>[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?:/(?<team>[A-Za-z0-9][\\w.-]{0,99}))?(?![\\w@])",
    "(?<![\\w/#&])#(?<reference>[1-9]\\d{0,9})\\b",
  ].join("|"),
  "g",
);

export function textSegments(
  text: string,
  known: {
    emoji?: ReadonlyMap<string, string> | undefined;
    footnotes?: ReadonlyMap<string, number> | undefined;
  },
): TextSegment[] {
  const segments: TextSegment[] = [];
  let end = 0;
  const plain = (to: number) => {
    if (to > end) segments.push({ kind: "text", text: text.slice(end, to) });
  };
  for (const match of text.matchAll(pattern)) {
    const groups = match.groups ?? {};
    let segment: TextSegment | undefined;
    if (groups.emoji !== undefined) {
      const emoji = known.emoji?.get(groups.emoji);
      if (emoji) segment = { kind: "emoji", emoji, code: groups.emoji };
    } else if (groups.footnote !== undefined) {
      const number = known.footnotes?.get(groups.footnote);
      if (number !== undefined) segment = { kind: "footnote", label: groups.footnote, number };
    } else if (groups.login !== undefined) {
      segment = { kind: "mention", login: groups.login, team: groups.team, text: match[0] };
    } else if (groups.reference !== undefined) {
      segment = { kind: "reference", number: Number(groups.reference), text: match[0] };
    }
    if (!segment) continue;
    plain(match.index);
    segments.push(segment);
    end = match.index + match[0].length;
  }
  plain(text.length);
  return segments;
}
