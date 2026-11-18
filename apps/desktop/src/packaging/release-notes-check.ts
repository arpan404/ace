/**
 * The checks a release's notes pass before the pipeline puts them on the release (ADR 0188).
 * Pure: the notes, the release's kind, the PRs in its range and the limits go in; every
 * problem comes out, so the agent can be told all of them when it retries.
 *
 * The app shows notes as lines with headings hidden (`apps/desktop/src/main/os/release-notes.ts`),
 * so a note holds only `## ` section headings and `- ` bullets: anything else would show as a
 * line of its own. A note is plain text: PR bodies can be edited after merge, so a link, URL or
 * HTML in the notes could have been planted there, and none is let through.
 */

export interface NotesLimits {
  /** Characters per bullet; the app cuts a line at 220. */
  bulletChars: number;
  /** Bullets across every section. */
  bullets: number;
  /** Characters in the whole note. */
  totalChars: number;
}

export interface NotesRules {
  kind: "beta" | "stable";
  /** The PRs the notes were written from: every bullet cites only these. */
  prs: ReadonlySet<number>;
  limits: NotesLimits;
  /** Names a note never mentions: other products and AI tools, matched as whole words. */
  bannedTerms: readonly string[];
}

const sectionsFor = (kind: NotesRules["kind"]) =>
  kind === "beta" ? ["New", "Improved", "Fixed", "Known issues"] : ["New", "Improved", "Fixed"];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bannedIn(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}($|[^\\p{L}\\p{N}])`, "iu").test(text),
  );
}

/** A URL with or without a scheme, a Markdown link, an autolink, or an HTML tag or comment. */
const linkOrHtml = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\.[a-z0-9-]/i,
  /\[[^\]]*\]\([^)]*\)/,
  /<[a-z!/][^>]*>/i,
  /\bmailto:/i,
];

function hasLinkOrHtml(text: string): boolean {
  return linkOrHtml.some((pattern) => pattern.test(text));
}

interface Bullet {
  section: string;
  text: string;
}

/** Every problem with `notes`; empty when they can go on the release. */
export function notesProblems(notes: string, rules: NotesRules): string[] {
  const problems: string[] = [];
  const required = sectionsFor(rules.kind);
  const seen: string[] = [];
  const bullets: Bullet[] = [];
  for (const [index, raw] of notes.split("\n").entries()) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      const name = (heading[1] ?? "").trim();
      if (hasLinkOrHtml(name))
        problems.push(
          `Heading "${name.slice(0, 60)}" holds a link, URL or HTML; notes are plain text`,
        );
      if (!required.includes(name)) problems.push(`Unknown section "${name}" on line ${index + 1}`);
      else if (seen.includes(name)) problems.push(`Section "${name}" appears twice`);
      seen.push(name);
      continue;
    }
    const bullet = /^- (.+)$/.exec(line);
    const section = seen.at(-1);
    if (!bullet) problems.push(`Line ${index + 1} is neither a "## " heading nor a "- " bullet`);
    else if (!section) problems.push(`Line ${index + 1} comes before the first section`);
    else bullets.push({ section, text: (bullet[1] ?? "").trim() });
  }
  const missing = required.filter((name) => !seen.includes(name));
  if (missing.length) problems.push(`Missing sections: ${missing.join(", ")}`);
  const order = seen.filter((name) => required.includes(name));
  if (!missing.length && order.join("|") !== required.join("|"))
    problems.push(`Sections must come in this order: ${required.join(", ")}`);

  const { limits } = rules;
  const changes = bullets.filter((bullet) => bullet.section !== "Known issues");
  if (changes.length === 0) problems.push("No bullet under New, Improved or Fixed");
  if (bullets.length > limits.bullets)
    problems.push(`${bullets.length} bullets; at most ${limits.bullets}`);
  if (notes.length > limits.totalChars)
    problems.push(`${notes.length} characters; at most ${limits.totalChars}`);
  for (const bullet of bullets) {
    const label = `"${bullet.text.slice(0, 60)}"`;
    if (bullet.text.length > limits.bulletChars)
      problems.push(`${label} is ${bullet.text.length} characters; at most ${limits.bulletChars}`);
    if (hasLinkOrHtml(bullet.text))
      problems.push(`${label} holds a link, URL or HTML; notes are plain text`);
    const cited = [...bullet.text.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));
    const unknown = cited.filter((number) => !rules.prs.has(number));
    if (cited.length === 0) problems.push(`${label} cites no PR (#<number>)`);
    else if (unknown.length)
      problems.push(
        `${label} cites ${unknown.map((n) => `#${n}`).join(", ")}, not in this release`,
      );
  }
  const banned = bannedIn(notes, rules.bannedTerms);
  if (banned.length) problems.push(`Mentions ${banned.join(", ")}`);
  return problems;
}
