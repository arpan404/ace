import { spadeRecord } from "./json.ts";

/*
 * A connected app's tool in the person's words (ADR 0202, amendment 5): "list your shared Notion
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
 * What the gate read a request's call as doing (ADR 0202, amendment 5), in the kinds a card is
 * headed by: never the tool's name. `ask: "app"` is an ordinary write Spade read by name, which
 * declares nothing; any other call that declares nothing is `unknown`.
 */
export type SpadeGateKind = "read" | "change" | "send" | "pay" | "access" | "unknown";

export function spadeGateKind(effect: string | undefined, ask?: string): SpadeGateKind {
  switch (effect) {
    case "read":
      return "read";
    case "network":
    case "write_local":
    case "publish":
      return "change";
    case "send_as_person":
      return "send";
    case "pay":
      return "pay";
    case "change_access":
    case "credential":
      return "access";
    default:
      return effect === undefined && ask === "app" ? "change" : "unknown";
  }
}

/**
 * What a connected app's tool would do, after "Quill wants to", in its own words: `list_shared_pages`
 * in Notion is "list your shared Notion pages", `create_page` is "create a Notion page",
 * `notion-search` is "search Notion". The lookup wording ("your …") is used only when the gate
 * read the call as a read (`effect`); otherwise a lookup-named tool reads as "use Notion to list
 * shared pages", so a name never vouches for itself. A leading word that only repeats the app's
 * name (`notion-…`, `API-…`) is dropped; a name joining two steps keeps its words.
 */
export function spadeAppToolPhrase(tool: string, app: string, effect?: string): string {
  const own = new Set([...words(app), "api"]);
  const all = words(tool);
  let start = 0;
  while (start < all.length - 1 && own.has(all[start] ?? "")) start += 1;
  const said = all.slice(start);
  const [verb, ...rest] = said;
  if (!verb) return `use ${app}`;
  const joined = rest.some((word) => word === "or" || word === "and" || word === "then");
  if (joined || (lookups.has(verb) && effect !== "read")) return `use ${app} to ${said.join(" ")}`;
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

/** Where a call goes, by the argument that names it, best first. */
const targetKeys = [
  "to",
  "recipient",
  "recipients",
  "email",
  "cc",
  "bcc",
  "url",
  "uri",
  "host",
  "endpoint",
  "webhook",
  "parent",
  "page_id",
  "database_id",
  "block_id",
  "channel",
  "id",
  "title",
  "name",
];

/** A value as a short plain word: text, a number, a person (`{name, email}`), a list of them. */
function plainTarget(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const each = value.map((item) => plainTarget(item, depth + 1)).filter(Boolean);
    return each.length ? each.join(", ") : undefined;
  }
  const fields = spadeRecord(value);
  if (!fields || depth > 4) return undefined;
  const named = plainTarget(fields.email, depth + 1) ?? plainTarget(fields.name, depth + 1);
  if (named) return named;
  return spadeAppCallTarget(fields, depth + 1);
}

/**
 * Where a call goes, from its arguments, nested ones included: its recipients, address, page or
 * title ("ana@example.com, sam@example.com"). Undefined when none of its fields names one.
 */
export function spadeAppCallTarget(args: unknown, depth = 0): string | undefined {
  const fields = spadeRecord(args);
  if (!fields || depth > 4) return undefined;
  const entries = Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value] as const);
  for (const key of targetKeys) {
    const found = entries.find(([name]) => name === key);
    const said = found && plainTarget(found[1], depth);
    if (said) return said;
  }
  for (const [, value] of entries) {
    if (typeof value !== "object" || value === null) continue;
    const said = spadeAppCallTarget(Array.isArray(value) ? value[0] : value, depth + 1);
    if (said) return said;
  }
  return undefined;
}

/** One call on an app's card: what it does in words, where it goes, and why the gate asked. */
export interface SpadeAppCallLine {
  text: string;
  /** What it makes or changes, by its title or name, when that isn't its target. */
  subject: string | undefined;
  target: string | undefined;
  reason: string | undefined;
}

/** A call's title or name, as given. */
function subjectOf(args: unknown): string | undefined {
  const fields = spadeRecord(args);
  const said = fields?.title ?? fields?.name;
  return typeof said === "string" && said.trim() ? said.trim() : undefined;
}

export interface SpadeAppRequestGroupWords {
  /** "Quill wants to make 3 changes in Notion." */
  sentence: string;
  lines: SpadeAppCallLine[];
}

/**
 * One card's words for several requests `who` made of the app `app` at once, all of one gate
 * kind (`spadeGroupAppRequests` splits them so): one sentence headed by that kind, never by the
 * tools' names, then each call with its target and the gate's reason.
 */
export function spadeAppRequestGroup(
  who: string,
  app: string,
  calls: readonly {
    tool: string;
    arguments: unknown;
    effect?: string | undefined;
    ask?: string | undefined;
    reason?: string | undefined;
  }[],
): SpadeAppRequestGroupWords {
  const lines = calls.map((call) => {
    const target = spadeAppCallTarget(call.arguments);
    const subject = subjectOf(call.arguments);
    return {
      text: capital(spadeAppToolPhrase(call.tool, app, call.effect)),
      subject: subject === target ? undefined : subject,
      target,
      reason: call.reason,
    };
  });
  const n = calls.length;
  const kind = calls[0] ? spadeGateKind(calls[0].effect, calls[0].ask) : "unknown";
  const sentence = {
    read: `${who} wants to read ${app}, ${n} times.`,
    change: `${who} wants to make ${n === 1 ? "a change" : `${n} changes`} in ${app}.`,
    send: `${who} wants to send ${n === 1 ? "something" : `${n} things`} in your name with ${app}.`,
    pay: `${who} wants to spend money with ${app}, ${n} times.`,
    access: `${who} wants to change who has access in ${app}, ${n} times.`,
    unknown: `${who} wants to use ${app} ${n} times, in ways it doesn't declare.`,
  }[kind];
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
 * Gathers each run of two or more open requests in a row to the same connected app, of the same
 * gate kind, into one group, so the person answers them on one card; requests of another kind
 * start a card of their own. Everything else stays as it is, in order.
 */
export function spadeGroupAppRequests<
  T extends { kind: string; name?: string; state?: string; effect?: string; ask?: string },
>(items: readonly T[]): SpadeGroupedItem<T>[] {
  const out: SpadeGroupedItem<T>[] = [];
  const keyOf = (item: T) => {
    if (item.kind !== "ask" || item.state !== "open" || !item.name) return undefined;
    const connection = spadeAppOfTool(item.name)?.connection;
    return connection === undefined
      ? undefined
      : { connection, key: `${connection}|${spadeGateKind(item.effect, item.ask)}` };
  };
  items.forEach((item, index) => {
    const mine = keyOf(item);
    const last = out.at(-1);
    if (mine && last) {
      const lastKey = last.kind === "one" ? keyOf(last.item)?.key : keyOf(last.items[0] as T)?.key;
      if (lastKey === mine.key) {
        if (last.kind === "app-group") last.items.push(item);
        else
          out[out.length - 1] = {
            kind: "app-group",
            connection: mine.connection,
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
