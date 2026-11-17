/*
 * Where the Marketplace modal is, as one `?market=` value, pure. The modal reads it on open and
 * writes it back as the person moves, so any link into it works and a reload lands where they
 * were: `?market=looks`, `?market=bot/inbox`, `?market=suit/mizzle/review`, `?market=@mira`.
 */

/** The five places of the top bar, and Installed at its right. */
export const marketPlaces = ["discover", "looks", "bots", "tools", "apps", "installed"] as const;
export type MarketPlace = (typeof marketPlaces)[number];

/** An entry by where it's listed: `source` is `market` or a git catalog's `git:` id. */
export interface MarketEntryKey {
  source: string;
  type: string;
  name: string;
}

/** A page pushed over a place. */
export type MarketPage =
  | { kind: "entry"; entry: MarketEntryKey }
  | { kind: "review"; entry: MarketEntryKey; update: boolean }
  | { kind: "publisher"; handle: string }
  | { kind: "collection"; id: string }
  | { kind: "profile" }
  /** `draft`: carry on with one of the publisher's drafts. */
  | { kind: "publish"; draft?: string | undefined }
  /** One of the publisher's own entries, to manage. */
  | { kind: "manage"; type: string; name: string }
  | { kind: "catalogs" };

export interface MarketView {
  place: MarketPlace;
  /** `spade`: opened from Spade, so only Spade's types show (no Looks). */
  scope: "all" | "spade";
  /** Installed's word choice: everything, or only what has an update. */
  installed: "all" | "updates";
  /** Pages over the place, the top one last. */
  pages: readonly MarketPage[];
}

const words: Readonly<Record<string, string>> = {
  suit: "suit",
  bot: "spade-bot",
  skill: "spade-skill",
  plugin: "spade-plugin",
};
const wordOf = (type: string) =>
  Object.entries(words).find(([, known]) => known === type)?.[0] ?? type;

/** The place an entry of `type` belongs to. */
export function placeOf(type: string): MarketPlace {
  if (type === "suit") return "looks";
  if (type === "spade-bot") return "bots";
  if (type === "spade-skill" || type === "spade-plugin" || type === "ace-plugin") return "tools";
  return "discover";
}

const slug = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const sourceId = /^(?:market|git:[a-z0-9]{1,32})$/;

function entryOf(word: string, rawName: string): MarketEntryKey | undefined {
  const at = rawName.lastIndexOf("@");
  const name = at > 0 ? rawName.slice(0, at) : rawName;
  const source = at > 0 ? rawName.slice(at + 1) : "market";
  const type = words[word] ?? word;
  if (!slug.test(name) || !sourceId.test(source) || !/^[a-z][a-z0-9-]{0,39}$/.test(type))
    return undefined;
  return { source, type, name };
}

const view = (place: MarketPlace, pages: MarketPage[] = []): MarketView => ({
  place,
  scope: "all",
  installed: "all",
  pages,
});

/**
 * The view a `?market=` value opens, or undefined when the modal is closed. Anything it can't
 * read opens Discover: a link that went stale still opens the Marketplace.
 */
export function parseMarket(value: unknown): MarketView | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text === "discover") return view("discover");
  if (text === "spade") return { ...view("discover"), scope: "spade" };
  if (text === "updates") return { ...view("installed"), installed: "updates" };
  if (text === "me") return view("discover", [{ kind: "profile" }]);
  if (text === "publish") return view("discover", [{ kind: "profile" }, { kind: "publish" }]);
  if (text === "catalogs") return view("installed", [{ kind: "catalogs" }]);
  const place = marketPlaces.find((known) => known === text);
  if (place) return view(place);
  if (text.startsWith("me/")) {
    const managed = entryOf(text.split("/")[1] ?? "", text.split("/")[2] ?? "");
    return managed && managed.source === "market"
      ? view("discover", [
          { kind: "profile" },
          { kind: "manage", type: managed.type, name: managed.name },
        ])
      : view("discover", [{ kind: "profile" }]);
  }
  if (text.startsWith("@")) {
    const handle = text.slice(1);
    return slug.test(handle) ? view("discover", [{ kind: "publisher", handle }]) : view("discover");
  }
  const [first = "", second = "", third] = text.split("/");
  if (first === "collection" && slug.test(second))
    return view("discover", [{ kind: "collection", id: second }]);
  const entry = entryOf(first, second);
  if (!entry) return view("discover");
  const pages: MarketPage[] = [{ kind: "entry", entry }];
  if (third === "review" || third === "update")
    pages.push({ kind: "review", entry, update: third === "update" });
  return view(placeOf(entry.type), pages);
}

const entryText = (entry: MarketEntryKey) =>
  `${wordOf(entry.type)}/${entry.name}${entry.source === "market" ? "" : `@${entry.source}`}`;

/** The `?market=` value for a view: its top page, else its place. */
export function formatMarket(at: MarketView): string {
  const top = at.pages.at(-1);
  switch (top?.kind) {
    case "entry":
      return entryText(top.entry);
    case "review":
      return `${entryText(top.entry)}/${top.update ? "update" : "review"}`;
    case "publisher":
      return `@${top.handle}`;
    case "collection":
      return `collection/${top.id}`;
    case "profile":
      return "me";
    case "publish":
      return "publish";
    case "manage":
      return `me/${entryText({ source: "market", type: top.type, name: top.name })}`;
    case "catalogs":
      return "catalogs";
    case undefined:
      if (at.place === "installed") return at.installed === "updates" ? "updates" : "installed";
      if (at.place === "discover" && at.scope === "spade") return "spade";
      return at.place;
  }
}

/** The `?market=` value that opens an entry's page. */
export const entryAddress = (entry: MarketEntryKey) => entryText(entry);

export const sameEntry = (a: MarketEntryKey, b: MarketEntryKey) =>
  a.source === b.source && a.type === b.type && a.name === b.name;
