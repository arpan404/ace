/**
 * Lexical ranking of ace tools against what an agent wants to do. Pure and deterministic: the
 * same catalogue and query always give the same order. Words are lowercased and stemmed, a small
 * synonym table bridges task words to tool words ("safari" → app, "tap" → click), and rarer
 * words count for more (IDF), so a family's shared vocabulary doesn't drown the specific tool.
 */

/** One tool as the session could call it. */
export interface SearchableTool {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  /** The guide topic of its family; absent for core tools without one. */
  readonly family?: string | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface SearchOptions {
  /** At most this many matches. */
  readonly limit: number;
  /** Only tools of this family. */
  readonly family?: string | undefined;
}

/** Where a word was found, and what a match there is worth. */
const weights = { name: 4, title: 3, family: 2, description: 1.5, field: 0.5 } as const;
/** A word reached only through a synonym counts for this share of a direct match. */
const synonymShare = 0.6;
/** Matches scoring under this share of the best one are noise, not alternatives. */
const relevanceFloor = 0.3;

const stopwords = new Set(
  "a an the in on at to of for with from into my your our this that these those and or is are be it its i me we you please how do does can could would should what which want need let lets just some any use using via tool tools ace next time now later other another".split(
    " ",
  ),
);

/** Words a family's tools answer to beyond their own text. */
const familyWords: Readonly<Record<string, string>> = {
  "ace-agents": "agent delegate parallel subagent child",
  "ace-browser": "browser web page website",
  "ace-computer-use": "computer native app desktop window simulator",
  "ace-threads": "thread conversation history",
  visualize: "visual chart diagram",
};

/** Each group's words stand in for one another. Stems, as `stem` returns them. */
const synonymGroups: readonly string[] = [
  "click tap press push hit select choose",
  "type enter fill keyboard key paste text",
  "button element widget menu ui",
  "app application native macos mac desktop window safari finder xcode mail calendar music photo slack figma",
  "simulator emulator iphone ipad ios android phone mobile sim",
  "page website site web url localhost browser",
  "console log network request output",
  "screenshot image picture capture visual look",
  "run start launch spawn kick begin execute",
  "task job work subtask",
  "other another remote different elsewhere paired machine host laptop server",
  "agent subagent child worker helper parallel delegate",
  "wait until finish done block result",
  "thread conversation chat session history transcript",
  "note remember memory knowledge fact",
  "schedule cron recur automation daily weekly periodic timer every",
  "pr pull github",
  "chart diagram graph mockup visualize render html",
  "ask question human person user",
  "cancel stop kill abort halt",
  "find search locate query",
  "open navigate go visit load",
  "measure latency performance smooth jank fps frame lag hitch",
];
const synonyms = new Map<string, readonly string[]>();
for (const group of synonymGroups) {
  const members = group.split(" ").map(stem);
  for (const word of members)
    synonyms.set(word, [
      ...(synonyms.get(word) ?? []),
      ...members.filter((other) => other !== word),
    ]);
}

/** A light English stemmer: plurals and -ing/-ed, so "clicked", "clicks" and "click" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 3 && /(?:sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  for (const suffix of ["ing", "ed"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      // running → run, dragged → drag
      if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  return w;
}

/** The meaningful stems of a text, in order. Snake and camel case split into words. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !stopwords.has(word))
    .map(stem)
    .filter((word) => !stopwords.has(word));
}

/** Property names and descriptions anywhere in a JSON schema, a bounded walk. */
function schemaText(node: unknown, into: string[], budget = { nodes: 200 }): string[] {
  if (typeof node !== "object" || node === null || --budget.nodes < 0) return into;
  if (Array.isArray(node)) {
    for (const child of node) schemaText(child, into, budget);
    return into;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && typeof value === "object" && value !== null)
      for (const [field, child] of Object.entries(value)) {
        into.push(field);
        schemaText(child, into, budget);
      }
    else if (key === "description" && typeof value === "string") into.push(value);
    else if (typeof value === "object") schemaText(value, into, budget);
  }
  return into;
}

/** Each stem of a tool, at the weight of the strongest field it appears in. */
function index(tool: SearchableTool): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const word of words(text)) terms.set(word, Math.max(terms.get(word) ?? 0, weight));
  };
  add(schemaText(tool.inputSchema, []).join(" "), weights.field);
  add(tool.description ?? "", weights.description);
  if (tool.family) add(`${tool.family} ${familyWords[tool.family] ?? ""}`, weights.family);
  add(tool.title ?? "", weights.title);
  add(tool.name, weights.name);
  return terms;
}

/** The tools that fit the query, best first; empty when none share a meaningful word. */
export function rankTools<T extends SearchableTool>(
  query: string,
  tools: readonly T[],
  options: SearchOptions,
): T[] {
  const candidates = tools.filter((tool) => !options.family || tool.family === options.family);
  const asked = [...new Set(words(query))];
  if (!asked.length || !candidates.length) return [];
  const indexed = candidates.map((tool) => ({ tool, terms: index(tool) }));
  // Rarity counts what tools are about, not the fields they share: a `machine` field on every
  // browser tool doesn't make "machine" a common word for `machines`.
  const frequency = new Map<string, number>();
  for (const { terms } of indexed)
    for (const [term, weight] of terms)
      if (weight >= weights.description) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const rarity = (term: string) => Math.log(1 + indexed.length / (1 + (frequency.get(term) ?? 0)));
  const exact = query.trim().toLowerCase();
  const scored = indexed.map(({ tool, terms }) => {
    let score = 0;
    let matched = 0;
    for (const word of asked) {
      const direct = (terms.get(word) ?? 0) * rarity(word);
      let related = 0;
      for (const other of synonyms.get(word) ?? [])
        related = Math.max(related, (terms.get(other) ?? 0) * rarity(other) * synonymShare);
      const best = Math.max(direct, related);
      if (best > 0) matched++;
      score += best;
    }
    // Naming the tool outright always ranks it first.
    if (exact === tool.name) score += 100;
    return { tool, score: score * (0.5 + (0.5 * matched) / asked.length) };
  });
  const top = Math.max(0, ...scored.map((entry) => entry.score));
  return scored
    .filter((entry) => entry.score > 0 && entry.score >= top * relevanceFloor)
    .toSorted((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1))
    .slice(0, options.limit)
    .map((entry) => entry.tool);
}
