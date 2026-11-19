import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import { AppsShelf } from "./market-apps.tsx";
import { useMarketHome, useMarketSearch } from "./market-api.ts";
import type { MarketPlace } from "./market-address.ts";
import { Card, CardItem, Cards, Empty, ResultRow, Section, shelfCount } from "./market-card.tsx";
import { Hero } from "./market-hero.tsx";
import { failureSentence } from "./market-model.ts";
import { useMarketNav } from "./market-nav.ts";
import { useMarketDiscover } from "./market-publishing.ts";
import { RankedSections } from "./market-ranked.tsx";

/*
 * Discover (the hero, then a shelf per type with See all), the type places, and search. Every
 * list reads the device's copy of the listings; a section with nothing in it isn't drawn.
 */

export const lookTypes = ["suit"] as const;
export const botTypes = ["spade-bot"] as const;
export const toolTypes = ["spade-skill", "spade-plugin"] as const;
const spadeTypes = [...botTypes, ...toolTypes];

const key = (entry: MarketEntrySummary) => `${entry.source}/${entry.type}/${entry.name}`;

function Shelf(props: {
  title: string;
  types: readonly string[];
  cols: 3 | 4;
  place: MarketPlace;
}) {
  const nav = useMarketNav();
  const found = useMarketSearch({ query: "", types: props.types });
  const all = found.data?.entries ?? [];
  const entries = all.slice(0, shelfCount(props.cols, all));
  if (!entries.length) return null;
  return (
    <Section title={props.title} all={() => nav.go(props.place)}>
      <Cards cols={props.cols} entries={entries} shelf label={props.title}>
        {entries.map((entry) => (
          <CardItem key={key(entry)}>
            <Card entry={entry} showKind={props.types.length > 1} />
          </CardItem>
        ))}
      </Cards>
    </Section>
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
  const featured = picks?.filter((entry) => !spade || entry.type !== "suit") ?? [];
  return (
    <div className="mk-inner">
      {featured.length > 0 && <Hero featured={featured} />}
      <RankedSections discover={discover} where="top" spade={spade} />
      {!spade && <Shelf title="Looks" types={lookTypes} cols={3} place="looks" />}
      <Shelf title="Bots" types={botTypes} cols={4} place="bots" />
      <RankedSections discover={discover} where="collections" spade={spade} />
      <Shelf title="Tools" types={toolTypes} cols={4} place="tools" />
      <AppsShelf />
      <RankedSections discover={discover} where="publishers" spade={spade} />
    </div>
  );
}

/** What a search finds, as rows; nothing found says so. */
export function SearchResults(props: { query: string; types?: readonly string[] | undefined }) {
  const found = useMarketSearch({ query: props.query, types: props.types });
  const entries = found.data?.entries;
  return (
    <div className="mk-inner" data-width="read">
      {found.isError && !found.data ? (
        <Empty title={failureSentence(found.error, "read")} />
      ) : !entries ? null : !entries.length ? (
        <Empty
          title={`Nothing matches “${props.query}”`}
          line="Try a shorter word, or a publisher's name."
        />
      ) : (
        <ul className="mk-rows" aria-label="Results">
          {entries.map((entry) => (
            <ResultRow key={key(entry)} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Looks: the first two large, then three across. */
export function LooksPage(props: { query: string }) {
  const found = useMarketSearch({ query: "", types: lookTypes });
  if (props.query) return <SearchResults query={props.query} types={lookTypes} />;
  const list = found.data?.entries ?? [];
  if (found.data && !list.length) return <Empty title="No looks are listed yet" />;
  return (
    <div className="mk-inner">
      {list.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Cards cols={2} entries={list.slice(0, 2)} label="Looks">
            {list.slice(0, 2).map((entry) => (
              <CardItem key={key(entry)}>
                <Card entry={entry} big showKind={false} />
              </CardItem>
            ))}
          </Cards>
        </div>
      )}
      {list.length > 2 && (
        <div style={{ marginTop: 40 }}>
          <Cards cols={3} entries={list.slice(2)} label="More looks">
            {list.slice(2).map((entry) => (
              <CardItem key={key(entry)}>
                <Card entry={entry} showKind={false} />
              </CardItem>
            ))}
          </Cards>
        </div>
      )}
    </div>
  );
}

function Group(props: {
  title: string;
  entries: readonly MarketEntrySummary[];
  first?: boolean;
  count?: boolean;
  phone?: "list";
}) {
  if (!props.entries.length) return null;
  return (
    <Section
      title={props.title}
      first={props.first}
      meta={props.count ? props.entries.length : undefined}
    >
      <Cards cols={4} entries={props.entries} phone={props.phone} label={props.title}>
        {props.entries.map((entry) => (
          <CardItem key={key(entry)}>
            <Card entry={entry} showKind={false} />
          </CardItem>
        ))}
      </Cards>
    </Section>
  );
}

/** Bots: Spade's templates (by ace) first, then those from publishers. */
export function BotsPage(props: { query: string }) {
  const found = useMarketSearch({ query: "", types: botTypes });
  if (props.query) return <SearchResults query={props.query} types={botTypes} />;
  const list = found.data?.entries ?? [];
  if (found.data && !list.length) return <Empty title="No bots are listed yet" />;
  const ace = list.filter((entry) => entry.byAce);
  return (
    <div className="mk-inner">
      <Group title="Spade's templates" entries={ace} first />
      <Group
        title="From publishers"
        entries={list.filter((entry) => !entry.byAce)}
        first={!ace.length}
      />
    </div>
  );
}

/** Tools: skills, then plugins, each with its count. */
export function ToolsPage(props: { query: string }) {
  const found = useMarketSearch({ query: "", types: toolTypes });
  if (props.query) return <SearchResults query={props.query} types={toolTypes} />;
  const list = found.data?.entries ?? [];
  if (found.data && !list.length) return <Empty title="No tools are listed yet" />;
  const skills = list.filter((entry) => entry.type === "spade-skill");
  return (
    <div className="mk-inner">
      <Group title="Skills" entries={skills} first count phone="list" />
      <Group
        title="Plugins"
        entries={list.filter((entry) => entry.type !== "spade-skill")}
        first={!skills.length}
        count
        phone="list"
      />
    </div>
  );
}
