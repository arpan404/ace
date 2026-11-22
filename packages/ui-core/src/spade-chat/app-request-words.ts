import { spadeRecord } from "./json.ts";

/*
 * A connected app's tool in the person's words (ADR 0202, amendment 2): "list your shared Notion
 * pages", never "use Notion notion list shared pages". And requests from one app that arrive
 * together, as one card: "Quill wants to do 3 things in Notion", the calls listed quietly under
 * it. Wording only: what runs, what is reviewed and what asks is Spade's gate's to decide.
 */

/** Verbs that lead a lookup, worded "list your shared Notion pages". */
const lookups = new Set([
  "list",
  "get",
  "search",
  "fetch",
  "query",
  "read",
  "retrieve",
  "find",
  "describe",
  "view",
  "show",
]);

/** A tool's name in lower-case words: `list_shared_pages`, `notion-search`, `listSharedPages`. */
function words(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * What a connected app's tool would do, after "Quill wants to": `list_shared_pages` in Notion is
 * "list your shared Notion pages", `create_page` is "create a Notion page", `notion-search` is
 * "search Notion". A leading word that only repeats the app's name (`notion-…`, `API-…`) is
 * dropped; a name joining two steps (`get_or_create_page`) keeps its words.
 */
export function spadeAppToolPhrase(tool: string, app: string): string {
  const own = new Set([...words(app), "api"]);
  const all = words(tool);
  let start = 0;
  while (start < all.length - 1 && own.has(all[start] ?? "")) start += 1;
  const said = all.slice(start);
  const [verb, ...rest] = said;
  if (!verb) return `use ${app}`;
  if (rest.some((word) => word === "or" || word === "and" || word === "then"))
    return `use ${app} to ${said.join(" ")}`;
  if (!rest.length) return `${verb} ${app}`;
  const last = rest.at(-1) ?? "";
  const between = rest.slice(0, -1);
  if (lookups.has(verb)) return [verb, "your", ...between, app, last].join(" ");
  const next = between[0] ?? app;
  const article = last.endsWith("s") ? [] : [/^[aeiou]/i.test(next) ? "an" : "a"];
  return [verb, ...article, ...between, app, last].join(" ");
}

/** "list your shared Notion pages" → "List your shared Notion pages". */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A call's few plain fields, for its quiet line: "Limit 100". */
function fieldsOf(args: unknown): string {
  const fields = spadeRecord(args);
  if (!fields) return "";
  return Object.entries(fields)
    .flatMap(([key, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [`${capital(key.replaceAll(/[_-]+/g, " "))} ${String(value)}`]
        : [],
    )
    .slice(0, 2)
    .join(", ");
}

export interface SpadeAppRequestGroupWords {
  /** "Quill wants to do 3 things in Notion." */
  sentence: string;
  /** One quiet line per call: "List your shared Notion pages · Limit 100". */
  lines: string[];
}

/**
 * One card's words for several requests `who` made of the app `app` at once: one sentence, the
 * calls listed under it. Reads read as reading the app; one tool asked many times names it once.
 */
export function spadeAppRequestGroup(
  who: string,
  app: string,
  calls: readonly { tool: string; arguments: unknown }[],
): SpadeAppRequestGroupWords {
  const lines = calls.map((call) => {
    const fields = fieldsOf(call.arguments);
    const phrase = capital(spadeAppToolPhrase(call.tool, app));
    return fields ? `${phrase} · ${fields}` : phrase;
  });
  const tools = new Set(calls.map((call) => call.tool));
  const reads = calls.every((call) => lookups.has(words(call.tool).find((w) => w !== "api") ?? ""));
  const [only] = tools;
  // What the reads are of, when they are all of one thing: "pages".
  const things = new Set(calls.map((call) => (words(call.tool).at(-1) ?? "").replace(/s$/, "")));
  const [thing] = things;
  const of = things.size === 1 && thing && words(app)[0] !== thing ? ` ${thing}s` : "";
  const sentence = reads
    ? `${who} wants to read your ${app}${of}.`
    : tools.size === 1 && only !== undefined
      ? `${who} wants to ${spadeAppToolPhrase(only, app)}, ${calls.length} times.`
      : `${who} wants to do ${calls.length} things in ${app}.`;
  return { sentence, lines };
}

/** The app a connected app's tool belongs to, by its offered name (`<connection>__<tool>`). */
export function spadeAppOfTool(name: string): { connection: string; tool: string } | undefined {
  const at = name.indexOf("__");
  if (at <= 0 || at + 2 >= name.length) return undefined;
  return { connection: name.slice(0, at), tool: name.slice(at + 2) };
}

/** A run's items with the open requests one app made together gathered into one group. */
export type SpadeGroupedItem<T> =
  | { kind: "one"; item: T; index: number }
  | { kind: "app-group"; connection: string; items: T[]; index: number };

/**
 * Gathers each run of two or more open requests in a row to the same connected app into one
 * group, so the person answers them on one card. Everything else stays as it is, in order.
 */
export function spadeGroupAppRequests<T extends { kind: string; name?: string; state?: string }>(
  items: readonly T[],
): SpadeGroupedItem<T>[] {
  const out: SpadeGroupedItem<T>[] = [];
  const appOf = (item: T) =>
    item.kind === "ask" && item.state === "open" && item.name
      ? spadeAppOfTool(item.name)?.connection
      : undefined;
  items.forEach((item, index) => {
    const connection = appOf(item);
    const last = out.at(-1);
    if (connection !== undefined && last) {
      if (last.kind === "app-group" && last.connection === connection) {
        last.items.push(item);
        return;
      }
      if (last.kind === "one" && appOf(last.item) === connection) {
        out[out.length - 1] = {
          kind: "app-group",
          connection,
          items: [last.item, item],
          index: last.index,
        };
        return;
      }
    }
    out.push({ kind: "one", item, index });
  });
  return out;
}
