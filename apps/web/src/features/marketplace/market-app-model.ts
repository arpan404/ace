import {
  spadeAppCategories,
  type SpadeAppCategory,
  type SpadeAppReady,
  type SpadeCatalogueEntry,
  type SpadeConnector,
} from "@ace/ui-core/spade-chat";

/*
 * Apps as Marketplace entries, pure: Spade's catalogue joined with the person's connections, so
 * every app is one entry with one state the whole store agrees on (its row, its page, search).
 * An app connected by address, outside the catalogue, is an entry too.
 */

/** Where an app stands for the person, in the order a list puts them first. */
export type StoreAppState =
  /** Connected and working. */
  | "connected"
  /** Its sign-in ended (or never finished): Reconnect. */
  | "signed_out"
  /** Connected, but Spade can't reach it now. */
  | "unreachable"
  /** A sign-in or a connection under way. */
  | "connecting"
  /** Not connected: Connect. */
  | "available"
  /** Listed, but it can't be connected on this build yet. */
  | "later";

export interface StoreApp {
  /** Its catalogue id, or its connector's id for one added by address. */
  id: string;
  /** The catalogue entry, for its mark; none for a server added by address. */
  catalogue: string | undefined;
  name: string;
  category: SpadeAppCategory;
  /** What the app's own notes say, for its page. */
  notes: string;
  ready: SpadeAppReady;
  /** Signs in through Spade Cloud with the person's ace account. */
  cloud: boolean;
  keyUrl: string | undefined;
  /** The person's connection to it, once there is one. */
  connector: SpadeConnector | undefined;
  state: StoreAppState;
}

const categoryLabels = new Map<string, string>(
  spadeAppCategories.map((each) => [each.id, each.label]),
);

/** "Mail & chat", "Work"…: an app's category in words. */
export const categoryLabel = (category: SpadeAppCategory) => categoryLabels.get(category) ?? "Work";

function stateOf(connector: SpadeConnector | undefined, ready: SpadeAppReady): StoreAppState {
  if (!connector) return ready === "later" ? "later" : "available";
  switch (connector.state) {
    case "connected":
      return "connected";
    case "needs_reconnect":
      return "signed_out";
    case "unreachable":
      return "unreachable";
    case "signing_in":
    case "connecting":
      return "connecting";
  }
}

/** Every app as a store entry: the catalogue in its order, then any added by address. */
export function storeApps(
  catalogue: readonly SpadeCatalogueEntry[],
  connectors: readonly SpadeConnector[],
): StoreApp[] {
  const byCatalogue = new Map(
    connectors.flatMap((each) => (each.catalogue ? [[each.catalogue, each] as const] : [])),
  );
  const listed = catalogue.map((entry): StoreApp => {
    const connector = byCatalogue.get(entry.id);
    return {
      id: entry.id,
      catalogue: entry.id,
      name: entry.name,
      category: entry.category,
      notes: entry.notes,
      ready: entry.ready,
      cloud: entry.via === "cloud",
      keyUrl: entry.keyUrl,
      connector,
      state: stateOf(connector, entry.ready),
    };
  });
  const own = connectors
    .filter((each) => !each.catalogue || !catalogue.some((entry) => entry.id === each.catalogue))
    .map((connector): StoreApp => ({
      id: connector.id,
      catalogue: connector.catalogue,
      name: connector.name,
      category: "work",
      notes: "",
      ready: "sign_in",
      cloud: connector.via === "cloud",
      keyUrl: undefined,
      connector,
      state: stateOf(connector, "sign_in"),
    }));
  return [...listed, ...own];
}

/** The person's own apps: connected, or once connected and now needing them. */
export const isYours = (app: StoreApp) => app.connector !== undefined;

/** An app's one line in a list: who it is signed in as, its state, or its category. */
export function appLine(app: StoreApp): string {
  const account = app.connector?.account;
  switch (app.state) {
    case "connected":
      return account ? `Connected as ${account}` : "Connected";
    case "signed_out":
      return "Signed out";
    case "unreachable":
      return "Can't reach it";
    case "connecting":
      return "Finishing sign-in";
    case "later":
      return "Not available yet";
    case "available":
      return categoryLabel(app.category);
  }
}

/** An app's line in a list already titled by its category: how it connects, else its state. */
export function connectLine(app: StoreApp): string {
  if (app.state !== "available") return appLine(app);
  if (app.ready === "key") return "Needs a key";
  return app.cloud ? "Signs in through Spade Cloud" : "Signs in on its own page";
}

/** How the app signs in, in plain words, for its page. */
export function signInWords(app: StoreApp): string {
  if (app.cloud)
    return `You sign in on ${app.name}'s own page, through Spade Cloud with your ace account.`;
  if (app.ready === "key") return `Needs a key you make in ${app.name}.`;
  if (app.ready === "later") return `${app.name} can't be connected from ace yet.`;
  return `You sign in on ${app.name}'s own page. Bots never see your password.`;
}

const normal = (text: string) => text.toLowerCase().normalize("NFKD");

/**
 * The apps a search finds, best first: a name that starts with the words, then a name that holds
 * them, then the category, then the notes. Every word typed must match somewhere.
 */
export function searchApps(apps: readonly StoreApp[], query: string): StoreApp[] {
  const words = normal(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = apps.flatMap((app) => {
    const name = normal(app.name);
    const category = normal(categoryLabel(app.category));
    const notes = normal(app.notes);
    let score = 0;
    for (const word of words) {
      if (name.startsWith(word)) score += 8;
      else if (name.includes(word)) score += 4;
      else if (category.includes(word)) score += 2;
      else if (notes.includes(word)) score += 1;
      else return [];
    }
    return [{ app, score }];
  });
  return scored.toSorted((a, b) => b.score - a.score).map((each) => each.app);
}
