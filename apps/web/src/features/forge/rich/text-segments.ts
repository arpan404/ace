/*
 * What GitHub links or draws inside plain text of PR and issue text (ADR 0096): emoji shortcodes
 * (`:tada:`, and GitHub's own image emoji like `:octocat:`), @mentions of people and teams,
 * `#123` and `owner/repo#123` references, commit SHAs (`owner/repo@sha` too), and footnote
 * markers (`[^1]`). Pure: the caller says which shortcodes and footnotes exist, and draws the
 * segments.
 */

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "emoji"; emoji: string; code: string }
  /** One of GitHub's image-only emoji, by the image URL GitHub lists for it. */
  | { kind: "image-emoji"; url: string; code: string }
  | { kind: "mention"; login: string; team?: string | undefined; text: string }
  | { kind: "reference"; number: number; text: string }
  | { kind: "cross-reference"; owner: string; repo: string; number: number; text: string }
  | {
      kind: "commit";
      sha: string;
      owner?: string | undefined;
      repo?: string | undefined;
      text: string;
    }
  | { kind: "footnote"; label: string; number: number };

const owner = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";
const repo = "[\\w.-]{1,100}";
const pattern = new RegExp(
  [
    ":(?<emoji>[a-z0-9_+-]{1,64}):",
    "\\[\\^(?<footnote>[^\\]\\s]{1,64})\\]",
    // `owner/repo#123` and `owner/repo@sha`, not inside a path or URL.
    `(?<![\\w/.@-])(?<xowner>${owner})/(?<xrepo>${repo})(?:#(?<xnumber>[1-9]\\d{0,9})\\b|@(?<xsha>[0-9a-f]{7,40})\\b)`,
    // A login: letters, digits and single hyphens; not inside an email address or a path.
    `(?<![\\w@/.\`])@(?<login>${owner})(?:/(?<team>[A-Za-z0-9][\\w.-]{0,99}))?(?![\\w@])`,
    "(?<![\\w/#&])#(?<reference>[1-9]\\d{0,9})\\b",
    // A commit SHA standing alone: 7 to 40 hex characters.
    "(?<![\\w/@#.-])(?<sha>[0-9a-f]{7,40})(?![\\w-])",
  ].join("|"),
  "g",
);

/**
 * Whether a hex word reads as a commit: a full SHA, or a short one that mixes digits and letters
 * (so words like `deadbeef`, numbers like `1234567` and colours stay text). GitHub links only
 * SHAs it finds in the repository; without asking it, this is the closest safe reading.
 */
function commitLike(word: string): boolean {
  return word.length === 40 || (/\d/.test(word) && /[a-f]/.test(word));
}

export function textSegments(
  text: string,
  known: {
    emoji?: ReadonlyMap<string, string> | undefined;
    /** GitHub's image-only emoji, name to image URL. */
    imageEmoji?: ReadonlyMap<string, string> | undefined;
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
      const image = known.imageEmoji?.get(groups.emoji);
      if (emoji) segment = { kind: "emoji", emoji, code: groups.emoji };
      else if (image) segment = { kind: "image-emoji", url: image, code: groups.emoji };
    } else if (groups.footnote !== undefined) {
      const number = known.footnotes?.get(groups.footnote);
      if (number !== undefined) segment = { kind: "footnote", label: groups.footnote, number };
    } else if (groups.xowner !== undefined && groups.xrepo !== undefined) {
      if (groups.xnumber !== undefined)
        segment = {
          kind: "cross-reference",
          owner: groups.xowner,
          repo: groups.xrepo,
          number: Number(groups.xnumber),
          text: match[0],
        };
      else if (groups.xsha !== undefined)
        segment = {
          kind: "commit",
          sha: groups.xsha,
          owner: groups.xowner,
          repo: groups.xrepo,
          text: `${groups.xowner}/${groups.xrepo}@${groups.xsha.slice(0, 7)}`,
        };
    } else if (groups.login !== undefined) {
      segment = { kind: "mention", login: groups.login, team: groups.team, text: match[0] };
    } else if (groups.reference !== undefined) {
      segment = { kind: "reference", number: Number(groups.reference), text: match[0] };
    } else if (groups.sha !== undefined && commitLike(groups.sha)) {
      segment = { kind: "commit", sha: groups.sha, text: groups.sha.slice(0, 7) };
    }
    if (!segment) continue;
    plain(match.index);
    segments.push(segment);
    end = match.index + match[0].length;
  }
  plain(text.length);
  return segments;
}
