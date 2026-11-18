import type { MarketDiscover, MarketTopPublisher } from "@ace/protocol/marketplace";
import { part } from "@/lib/suit-part.ts";
import { Card, CardItem, Cards, Section, publisherName, shelfCount } from "./market-card.tsx";
import { typeWord } from "./market-model.ts";
import { Avatar, Move, Verified } from "./market-marks.tsx";
import { openEntry, useMarketNav } from "./market-nav.ts";
import { useMarketPicture } from "./market-publishing.ts";
import { Stage } from "./market-stage.tsx";

/*
 * Discover's ranked sections (ADR 0174 §6): Trending this week as two columns of five, New and
 * notable, collections as a mosaic of what's inside, and the top publishers. Each renders only
 * when its list has something in it.
 */

type MarketTrendingView = MarketDiscover["trending"][number];
type MarketCollectionView = MarketDiscover["collections"][number];

export function TrendingSection(props: { rows: readonly MarketTrendingView[] }) {
  if (!props.rows.length) return null;
  return (
    <Section title="Trending this week">
      <ol
        className="mk-ranked"
        aria-label="Trending this week"
        style={{ listStyle: "none", margin: 0, padding: 0 }}
      >
        {props.rows
          .toSorted((a, b) => a.rank - b.rank)
          .slice(0, 10)
          .map((row) => (
            <TrendingRow key={`${row.entry.type}/${row.entry.name}`} row={row} />
          ))}
      </ol>
    </Section>
  );
}

function TrendingRow(props: { row: MarketTrendingView }) {
  const nav = useMarketNav();
  const { entry } = props.row;
  return (
    <li style={{ display: "contents" }}>
      <button
        type="button"
        {...part("list-row", undefined, "market-trending")}
        className="mk-rank-row"
        onClick={() => openEntry(nav, entry)}
      >
        <span className="mk-rank">{props.row.rank}</span>
        <Stage entry={entry} size="small" />
        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span className="mk-name mk-clamp1">{entry.title}</span>
          <span className="mk-meta mk-clamp1">
            {[typeWord(entry.type), publisherName(entry)].filter(Boolean).join(" · ")}
          </span>
        </span>
        <Move move={props.row.movement} />
      </button>
    </li>
  );
}

export function CollectionCard(props: { collection: MarketCollectionView }) {
  const nav = useMarketNav();
  const { collection } = props;
  const open = () => nav.push({ kind: "collection", id: collection.id });
  return (
    <CardItem>
      <div {...part("card", undefined, "market-collection")} className="mk-card">
        <button type="button" className="mk-card-open" aria-label={collection.title} onClick={open}>
          <div className="mk-mosaic">
            {collection.entries.slice(0, 5).map((entry, at) => (
              <Stage
                key={`${entry.type}/${entry.name}`}
                entry={entry}
                size={at ? "small" : "card"}
              />
            ))}
          </div>
        </button>
        <div className="mk-card-words">
          <div className="mk-card-top">
            <button
              type="button"
              className="mk-name"
              style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}
              onClick={open}
            >
              {collection.title}
            </button>
            <span className="mk-meta">{collection.entries.length} entries</span>
          </div>
          <span className="mk-line">{collection.line}</span>
        </div>
      </div>
    </CardItem>
  );
}

export function PublisherCard(props: { publisher: MarketTopPublisher }) {
  const nav = useMarketNav();
  const { publisher } = props;
  const picture = useMarketPicture("avatar", publisher.avatar);
  return (
    <CardItem>
      <button
        type="button"
        {...part("card", undefined, "market-publisher")}
        className="mk-pub-card"
        onClick={() => nav.push({ kind: "publisher", handle: publisher.handle })}
      >
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Avatar name={publisher.displayName} size={48} picture={picture} />
          <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <span className="mk-pub-name">
              {publisher.displayName}
              {publisher.verified && <Verified />}
            </span>
            <span className="mk-meta">
              @{publisher.handle} · {publisher.entries}{" "}
              {publisher.entries === 1 ? "entry" : "entries"}
            </span>
          </span>
        </span>
      </button>
    </CardItem>
  );
}

/** The ranked sections, in Discover's order, each only when it has entries. */
export function RankedSections(props: {
  discover: MarketDiscover | undefined;
  where: "top" | "collections" | "publishers";
  spade: boolean;
}) {
  const discover = props.discover;
  if (!discover) return null;
  const shown = (type: string) => !props.spade || type !== "suit";
  if (props.where === "top") {
    const fresh = discover.fresh.filter((entry) => shown(entry.type));
    const newest = fresh.slice(0, shelfCount(4, fresh));
    return (
      <>
        <TrendingSection rows={discover.trending.filter((row) => shown(row.entry.type))} />
        {newest.length > 0 && (
          <Section title="New and notable">
            <Cards cols={4} entries={newest} shelf label="New and notable">
              {newest.map((entry) => (
                <CardItem key={`${entry.type}/${entry.name}`}>
                  <Card entry={entry} />
                </CardItem>
              ))}
            </Cards>
          </Section>
        )}
      </>
    );
  }
  if (props.where === "collections")
    return discover.collections.length ? (
      <Section title="Collections">
        <Cards cols={2} shelf label="Collections">
          {discover.collections.slice(0, 2).map((collection) => (
            <CollectionCard key={collection.id} collection={collection} />
          ))}
        </Cards>
      </Section>
    ) : null;
  return discover.publishers.length ? (
    <Section title="Top publishers">
      <Cards cols={4} shelf label="Top publishers">
        {discover.publishers.slice(0, 4).map((publisher) => (
          <PublisherCard key={publisher.handle} publisher={publisher} />
        ))}
      </Cards>
    </Section>
  ) : null;
}
