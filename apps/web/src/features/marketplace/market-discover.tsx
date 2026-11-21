import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import { AppsShelf, useMarketApps } from "./market-apps.tsx";
import { useMarketHome, useMarketSearch } from "./market-api.ts";
import type { MarketPlace } from "./market-address.ts";
import { searchApps } from "./market-app-model.ts";
import { Card, CardItem, Cards, Empty } from "./market-card.tsx";
import { failureSentence } from "./market-model.ts";
import { openEntry, useMarketNav } from "./market-nav.ts";
import { useMarketDiscover } from "./market-publishing.ts";
import { RankedSections } from "./market-ranked.tsx";
import { Stage } from "./market-stage.tsx";
import {
  AppRow,
  EntryRow,
  entryKeyOf,
  GetButton,
  Shelf,
  StoreRows,
} from "./market-store-row.tsx";

/*
 * Home (featured, then a few named shelves), the type places, and search across everything:
 * bots, apps, tools and looks in one list of sections. Every list reads the device's copy of the
 * listings; a shelf with nothing in it isn't drawn.
 */

export const lookTypes = ["suit"] as const;
export const botTypes = ["spade-bot"] as const;
export const toolTypes = ["spade-skill", "spade-plugin"] as const;
const spadeTypes = [...botTypes, ...toolTypes];

const byDownloads = (entries: readonly MarketEntrySummary[]) =>
  entries.toSorted((a, b) => b.downloads - a.downloads);

/** One of the two featured pictures: the entry's own look, then its words and its button. */
function Feature(props: { entry: MarketEntrySummary; eyebrow: string }) {
  const nav = useMarketNav();
  const { entry } = props;
  return (
    <div className="st-feature">
      <button
        type="button"
        className="st-feature-picture"
        aria-label={entry.title}
        onClick={() => openEntry(nav, entry)}
      >
        <Stage entry={entry} size="card" />
      </button>
      <div className="flex items-start justify-between gap-4">
        <div className="grid min-w-0 gap-1">
          <span className="st-eyebrow">{props.eyebrow}</span>
          <span className="st-name" style={{ fontSize: "var(--text-lg)" }}>
            {entry.title}
          </span>
          <span className="st-line">{entry.line}</span>
        </div>
        <GetButton entry={entry} />
      </div>
    </div>
  );
}

const eyebrowOf = (entry: MarketEntrySummary) =>
  entry.type === "suit" ? "A new look" : entry.type === "spade-bot" ? "A bot for you" : "A tool";

function TypeShelf(props: {
  title: string;
  types: readonly string[];
  place: MarketPlace;
  popular?: boolean;
  skip?: ReadonlySet<string>;
}) {
  const nav = useMarketNav();
  const found = useMarketSearch({ query: "", types: props.types });
  const all = found.data?.entries ?? [];
  const listed = (props.popular ? byDownloads(all) : all).filter(
    (entry) => !props.skip?.has(entryKeyOf(entry)),
  );
  const entries = listed.slice(0, 6);
  if (!entries.length) return null;
  return (
    <Shelf title={props.title} all={() => nav.go(props.place)}>
      <StoreRows label={props.title}>
        {entries.map((entry) => (
          <EntryRow key={entryKeyOf(entry)} entry={entry} />
        ))}
      </StoreRows>
    </Shelf>
  );
}

function LooksShelf() {
  const nav = useMarketNav();
  const found = useMarketSearch({ query: "", types: lookTypes });
  const list = (found.data?.entries ?? []).slice(0, 3);
  if (!list.length) return null;
  return (
    <Shelf title="Looks" all={() => nav.go("looks")}>
      <Cards cols={3} entries={list} shelf label="Looks">
        {list.map((entry) => (
          <CardItem key={entryKeyOf(entry)}>
            <Card entry={entry} showKind={false} />
          </CardItem>
        ))}
      </Cards>
    </Shelf>
  );
}

export function DiscoverPage(props: { query: string }) {
  const nav = useMarketNav();
  const spade = nav.view.scope === "spade";
  const home = useMarketHome();
  const discover = useMarketDiscover();
  if (props.query)
    return <SearchResults query={props.query} types={spade ? spadeTypes : undefined} />;
  if (home.isError && !home.data) return <Empty title={failureSentence(home.error, "read")} />;
  // Discover's own picks once the market has them, else the listings' featured ones.
  const picks = discover?.featured.length ? discover.featured : home.data?.featured;
  const featured = (picks?.filter((entry) => !spade || entry.type !== "suit") ?? []).slice(0, 2);
  const skip = new Set(featured.map(entryKeyOf));
  return (
    <div className="mk-inner">
      {featured.length > 0 && (
        <section className="st-featured" aria-label="Featured">
          {featured.map((entry) => (
            <Feature key={entryKeyOf(entry)} entry={entry} eyebrow={eyebrowOf(entry)} />
          ))}
        </section>
      )}
      <TypeShelf title="Popular bots" types={botTypes} place="bots" popular skip={skip} />
      <AppsShelf />
      {!spade && <LooksShelf />}
      <TypeShelf title="Tools for your bots" types={toolTypes} place="tools" skip={skip} />
      <RankedSections discover={discover} where="publishers" spade={spade} />
    </div>
  );
}

const sectionOf = (type: string) =>
  type === "suit" ? "Looks" : type === "spade-bot" ? "Bots" : "Tools";

/**
 * What a search finds across the store, in sections by kind (Bots, Apps, Tools, Looks), the
 * section with the best match first; nothing found says so.
 */
export function SearchResults(props: { query: string; types?: readonly string[] | undefined }) {
  const found = useMarketSearch({ query: props.query, types: props.types });
  const apps = useMarketApps();
  const entries = found.data?.entries;
  // Apps sit beside every kind except where a search is narrowed to one (Looks, Bots, Tools).
  const appsFound = apps && props.types?.length !== 1 ? searchApps(apps, props.query) : [];
  if (found.isError && !found.data)
    return <Empty title={failureSentence(found.error, "read")} />;
  if (!entries) return null;
  if (!entries.length && !appsFound.length)
    return (
      <Empty
        title={`Nothing matches “${props.query}”`}
        line="Try a shorter word, an app's name, or a publisher's name."
      />
    );
  // Sections in the order their best result came: the market ranks its own, an app's name
  // starting with the words goes first.
  const order: string[] = [];
  const appFirst = appsFound[0]?.name.toLowerCase().startsWith(props.query.trim().toLowerCase());
  if (appFirst) order.push("Apps");
  for (const entry of entries) {
    const section = sectionOf(entry.type);
    if (!order.includes(section)) order.push(section);
  }
  if (appsFound.length && !order.includes("Apps")) order.push("Apps");
  return (
    <div className="mk-inner" aria-label="Results" role="region">
      {order.map((section) =>
        section === "Apps" ? (
          <Shelf key={section} title="Apps">
            <StoreRows label="Apps" cols={2}>
              {appsFound.slice(0, 8).map((app) => (
                <AppRow key={app.id} app={app} />
              ))}
            </StoreRows>
          </Shelf>
        ) : (
          <Shelf key={section} title={section}>
            <StoreRows label={section} cols={2}>
              {entries
                .filter((entry) => sectionOf(entry.type) === section)
                .map((entry) => (
                  <EntryRow key={entryKeyOf(entry)} entry={entry} />
                ))}
            </StoreRows>
          </Shelf>
        ),
      )}
    </div>
  );
}

/** The Apps place's search: only apps. */
export function AppSearch(props: { query: string }) {
  const found = searchApps(useMarketApps() ?? [], props.query);
  if (!found.length)
    return <Empty title={`No app matches “${props.query}”`} line="Try a shorter word." />;
  return (
    <div className="mk-inner">
      <Shelf title="Apps">
        <StoreRows label="Apps" cols={2}>
          {found.map((app) => (
            <AppRow key={app.id} app={app} />
          ))}
        </StoreRows>
      </Shelf>
    </div>
  );
}

/** Looks: their windows, three across. */
export function LooksPage(props: { query: string }) {
  const found = useMarketSearch({ query: "", types: lookTypes });
  if (props.query) return <SearchResults query={props.query} types={lookTypes} />;
  const list = found.data?.entries ?? [];
  if (found.data && !list.length) return <Empty title="No looks are listed yet" />;
  return (
    <div className="mk-inner">
      <Shelf title="Looks">
        <Cards cols={3} entries={list} label="Looks">
          {list.map((entry) => (
            <CardItem key={entryKeyOf(entry)}>
              <Card entry={entry} showKind={false} />
            </CardItem>
          ))}
        </Cards>
      </Shelf>
    </div>
  );
}

function RowsShelf(props: { title: string; entries: readonly MarketEntrySummary[] }) {
  if (!props.entries.length) return null;
  return (
    <Shelf title={props.title}>
      <StoreRows label={props.title}>
        {props.entries.map((entry) => (
          <EntryRow key={entryKeyOf(entry)} entry={entry} />
        ))}
      </StoreRows>
    </Shelf>
  );
}

/** Bots: the most used first, then ace's templates, then those from publishers. */
export function BotsPage(props: { query: string }) {
  const found = useMarketSearch({ query: "", types: botTypes });
  if (props.query) return <SearchResults query={props.query} types={botTypes} />;
  const list = found.data?.entries ?? [];
  if (found.data && !list.length) return <Empty title="No bots are listed yet" />;
  return (
    <div className="mk-inner">
      <RowsShelf title="From ace" entries={list.filter((entry) => entry.byAce)} />
      <RowsShelf title="From publishers" entries={list.filter((entry) => !entry.byAce)} />
    </div>
  );
}

/** Tools: skills, then plugins. */
export function ToolsPage(props: { query: string }) {
  const found = useMarketSearch({ query: "", types: toolTypes });
  if (props.query) return <SearchResults query={props.query} types={toolTypes} />;
  const list = found.data?.entries ?? [];
  if (found.data && !list.length) return <Empty title="No tools are listed yet" />;
  return (
    <div className="mk-inner">
      <RowsShelf title="Skills" entries={list.filter((entry) => entry.type === "spade-skill")} />
      <RowsShelf title="Plugins" entries={list.filter((entry) => entry.type !== "spade-skill")} />
    </div>
  );
}
