import {
  spadeAppCategories,
  type SpadeAppCategory,
  type SpadeAppReady,
  type SpadeCatalogueEntry,
} from "@ace/ui-core/spade-chat";

/*
 * Which catalogue apps the Connect an app list shows, in what groups and order (pure, so it is
 * tested directly). Without a search: the apps already added (connected or signing in), then the ones the person
 * reached for lately, then every other app under its category. A search looks across every
 * category at once, names first. Within a group, apps that connect now come before ones that need
 * a key, and those before ones that aren't ready yet.
 */

export type AppFilter = SpadeAppCategory | "all";

export interface AppSection {
  key: string;
  /** None for a search's results. */
  title: string | undefined;
  entries: readonly SpadeCatalogueEntry[];
}

const readiness: Record<SpadeAppReady, number> = { sign_in: 0, key: 1, later: 2 };
const labels = new Map<string, string>(spadeAppCategories.map((each) => [each.id, each.label]));

const byReadyThenName = (a: SpadeCatalogueEntry, b: SpadeCatalogueEntry) =>
  readiness[a.ready] - readiness[b.ready] || a.name.localeCompare(b.name);

/** How well `entry` answers `words`: 0 its name starts so, 1 its name holds it, 2 elsewhere. */
function rank(entry: SpadeCatalogueEntry, words: string): number | undefined {
  const name = entry.name.toLocaleLowerCase();
  if (name.startsWith(words) || entry.id.startsWith(words)) return 0;
  if (name.includes(words)) return 1;
  const elsewhere = [labels.get(entry.category) ?? "", entry.notes].join(" ").toLocaleLowerCase();
  return elsewhere.includes(words) ? 2 : undefined;
}

export function appSections(
  catalogue: readonly SpadeCatalogueEntry[],
  options: {
    text: string;
    filter: AppFilter;
    /** Catalogue ids already added: connected, signing in, or signed out. */
    added: ReadonlySet<string>;
    /** Catalogue ids the person reached for lately, latest first. */
    recent: readonly string[];
  },
): AppSection[] {
  const words = options.text.trim().toLocaleLowerCase();
  if (words) {
    const found = catalogue.flatMap((entry) => {
      const score = rank(entry, words);
      return score === undefined ? [] : [{ entry, score }];
    });
    found.sort((a, b) => a.score - b.score || byReadyThenName(a.entry, b.entry));
    return [{ key: "found", title: undefined, entries: found.map((each) => each.entry) }];
  }
  if (options.filter !== "all") {
    const inCategory = catalogue.filter((entry) => entry.category === options.filter);
    const addedFirst = (a: SpadeCatalogueEntry, b: SpadeCatalogueEntry) =>
      Number(options.added.has(b.id)) - Number(options.added.has(a.id)) || byReadyThenName(a, b);
    return [
      {
        key: options.filter,
        title: labels.get(options.filter),
        entries: inCategory.toSorted(addedFirst),
      },
    ];
  }
  const byId = new Map(catalogue.map((entry) => [entry.id, entry]));
  const added = catalogue
    .filter((entry) => options.added.has(entry.id))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const recent = options.recent.flatMap((id) => {
    const entry = byId.get(id);
    return entry && !options.added.has(id) ? [entry] : [];
  });
  const shown = new Set([...added, ...recent].map((entry) => entry.id));
  const sections: AppSection[] = [];
  if (added.length) sections.push({ key: "added", title: "Your apps", entries: added });
  if (recent.length) sections.push({ key: "recent", title: "Recent", entries: recent });
  for (const category of spadeAppCategories) {
    const entries = catalogue
      .filter((entry) => entry.category === category.id && !shown.has(entry.id))
      .toSorted(byReadyThenName);
    if (entries.length) sections.push({ key: category.id, title: category.label, entries });
  }
  return sections;
}
