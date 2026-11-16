import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import type { ReactNode } from "react";
import { part } from "@/lib/suit-part.ts";
import { typeWord } from "./market-model.ts";
import { Byline } from "./market-marks.tsx";
import { openEntry, useMarketNav } from "./market-nav.ts";
import { Stage } from "./market-stage.tsx";

/*
 * Cards (the visual leads, the words sit under it), result rows and the section a shelf sits in.
 * Every card and row opens its entry's page; the byline opens its publisher once publisher pages
 * exist (ADR 0173).
 */

/** Who published it, in a byline's words: ace, a publisher, or a git catalog. */
export function publisherName(entry: Pick<MarketEntrySummary, "byAce" | "publisher" | "from">) {
  if (entry.byAce) return "ace";
  if (entry.publisher) return entry.publisher.name;
  return entry.from?.replace(/^https:\/\//, "");
}

export function EntryByline(props: { entry: MarketEntrySummary }) {
  const name = publisherName(props.entry);
  if (!name) return null;
  return (
    <Byline
      name={name}
      ace={props.entry.byAce}
      verified={props.entry.byAce || Reflect.get(props.entry, "verified") === true}
    />
  );
}

export function Card(props: {
  entry: MarketEntrySummary;
  big?: boolean;
  /** The kind beside the name, where a shelf mixes types. */
  showKind?: boolean;
}) {
  const nav = useMarketNav();
  const { entry } = props;
  const open = () => openEntry(nav, entry);
  return (
    <div
      {...part("card", undefined, "market-entry")}
      className="mk-card"
      data-big={props.big ? "" : undefined}
    >
      <button type="button" className="mk-card-open" tabIndex={-1} aria-hidden onClick={open}>
        <Stage entry={entry} size="card" />
      </button>
      <div className="mk-card-words">
        <div className="mk-card-top">
          <button type="button" className="mk-name mk-clamp1" onClick={open}>
            {entry.title}
          </button>
          {props.showKind !== false && <span className="mk-meta">{typeWord(entry.type)}</span>}
        </div>
        <span className="mk-line mk-clamp2">{entry.line}</span>
        <EntryByline entry={entry} />
      </div>
    </div>
  );
}

/** A grid of cards. `shelf`: one row on Discover that scrolls sideways on a phone. */
export function Cards(props: {
  cols: 2 | 3 | 4;
  shelf?: boolean;
  phone?: "grid" | "list" | undefined;
  quad?: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="list"
      aria-label={props.label}
      className="mk-cards"
      data-cols={props.cols}
      data-shelf={props.shelf ? "" : undefined}
      data-phone={props.phone}
      data-quad={props.quad ? "" : undefined}
    >
      {props.children}
    </div>
  );
}

/** One card as a list item, so a shelf reads as a list. */
export function CardItem(props: { children: ReactNode }) {
  return (
    <div role="listitem" style={{ display: "contents" }}>
      {props.children}
    </div>
  );
}

/** A search result or a list row: small stage, name, line, who; the kind at the right. */
export function ResultRow(props: { entry: MarketEntrySummary }) {
  const nav = useMarketNav();
  const { entry } = props;
  const who = publisherName(entry);
  return (
    <li>
      <button
        type="button"
        {...part("list-row", undefined, "market")}
        className="mk-row"
        onClick={() => openEntry(nav, entry)}
      >
        <Stage entry={entry} size="small" />
        <span className="mk-words">
          <span className="mk-name">{entry.title}</span>
          <span className="mk-line mk-clamp1">{entry.line}</span>
          {who && <span className="mk-meta">{who}</span>}
        </span>
        <span className="mk-meta">{typeWord(entry.type)}</span>
      </button>
    </li>
  );
}

/** A titled section of a page; `all` is its "See all" (a place), `meta` a quiet count. */
export function Section(props: {
  title: string;
  first?: boolean | undefined;
  all?: (() => void) | undefined;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      {...part("page-section", undefined, "market")}
      className="mk-section"
      data-first={props.first ? "" : undefined}
      aria-label={props.title}
    >
      <div className="mk-section-head">
        <h2 className="mk-h2">{props.title}</h2>
        {props.all ? (
          <button type="button" className="mk-quiet" onClick={props.all}>
            See all
          </button>
        ) : props.meta !== undefined ? (
          <span className="mk-meta">{props.meta}</span>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

/** Nothing to show here, in a sentence and a hint. */
export function Empty(props: { title: string; line?: string | undefined; children?: ReactNode }) {
  return (
    <div {...part("empty-state", undefined, "market")} className="mk-empty">
      <span className="mk-name">{props.title}</span>
      {props.line && <span className="mk-line">{props.line}</span>}
      {props.children}
    </div>
  );
}
