import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import { createContext, useContext, type ReactNode } from "react";
import { part } from "@/lib/suit-part.ts";
import { typeWord } from "./market-model.ts";
import { Byline } from "./market-marks.tsx";
import { openEntry, useMarketNav } from "./market-nav.ts";
import { Stage } from "./market-stage.tsx";

/*
 * Cards, result rows and the section a shelf sits in. A card leads with its picture when every
 * entry in its list has one to show (a Suit's window, a listing's pictures); otherwise the list
 * is lockups, a small mark beside the words, so nothing draws a large empty box. Every card and
 * row opens its entry's page; the byline opens its publisher's page (ADR 0174).
 */

/** `stage`: the picture leads and the words sit under it. `lockup`: a small mark beside them. */
export type CardForm = "stage" | "lockup";

/** Stages only when every entry has a picture: Suits draw their window, others need previews. */
export const cardForm = (
  entries: readonly Pick<MarketEntrySummary, "type" | "previews">[],
): CardForm =>
  entries.length > 0 &&
  entries.every((entry) => entry.type === "suit" || (entry.previews?.length ?? 0) > 0)
    ? "stage"
    : "lockup";

const CardFormContext = createContext<CardForm>("stage");

/** Who published it, in a byline's words: ace, a publisher, or a git catalog. */
export function publisherName(entry: Pick<MarketEntrySummary, "byAce" | "publisher" | "from">) {
  if (entry.byAce) return "ace";
  if (entry.publisher) return entry.publisher.name;
  return entry.from?.replace(/^https:\/\//, "");
}

/** The publisher's handle on the market, whose page the byline opens; none for git catalogs. */
export const publisherHandle = (entry: Pick<MarketEntrySummary, "source" | "publisher">) =>
  entry.source === "market" ? entry.publisher?.name : undefined;

/**
 * "By ace" and "Verified" only from what the daemon checked: `byAce` and `verified` are set from
 * the signed official and verified lists, for a publisher a verified manifest names.
 */
export const entryVerified = (entry: Pick<MarketEntrySummary, "byAce" | "verified">) =>
  entry.byAce || entry.verified === true;

export function EntryByline(props: { entry: MarketEntrySummary; inert?: boolean }) {
  const nav = useMarketNav();
  const name = publisherName(props.entry);
  const handle = publisherHandle(props.entry);
  if (!name) return null;
  return (
    <Byline
      name={name}
      ace={props.entry.byAce}
      verified={entryVerified(props.entry)}
      onOpen={handle && !props.inert ? () => nav.push({ kind: "publisher", handle }) : undefined}
    />
  );
}

export function Card(props: {
  entry: MarketEntrySummary;
  big?: boolean;
  /** The kind beside the name, where a shelf mixes types. */
  showKind?: boolean;
  /** Its form when it stands alone; in `Cards`, the list decides. */
  form?: CardForm;
}) {
  const nav = useMarketNav();
  const listForm = useContext(CardFormContext);
  const form = props.form ?? listForm;
  const { entry } = props;
  const open = () => openEntry(nav, entry);
  return (
    <div
      {...part("card", undefined, "market-entry")}
      className="mk-card"
      data-form={form}
      data-big={props.big && form === "stage" ? "" : undefined}
    >
      <button type="button" className="mk-card-open" tabIndex={-1} aria-hidden onClick={open}>
        <Stage entry={entry} size={form === "stage" ? "card" : "small"} />
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

/**
 * A grid of cards, in the form `entries` decides (`cardForm`); without entries (publishers,
 * collections) they are stages. `shelf`: a row on Discover that scrolls sideways on a phone.
 */
export function Cards(props: {
  cols: 2 | 3 | 4;
  entries?: readonly MarketEntrySummary[];
  shelf?: boolean;
  phone?: "grid" | "list" | undefined;
  quad?: boolean;
  label?: string;
  children: ReactNode;
}) {
  const form = props.entries ? cardForm(props.entries) : "stage";
  return (
    <CardFormContext value={form}>
      <div
        role="list"
        aria-label={props.label}
        className="mk-cards"
        data-cols={props.cols}
        data-form={form}
        data-shelf={props.shelf ? "" : undefined}
        data-phone={props.phone}
        data-quad={props.quad ? "" : undefined}
      >
        {props.children}
      </div>
    </CardFormContext>
  );
}

/** How many entries a shelf of `cols` shows: one row of stages, or two of lockups. */
export const shelfCount = (cols: number, entries: readonly MarketEntrySummary[]) =>
  cardForm(entries.slice(0, cols)) === "stage" ? cols : cols * 2;

/** One card as a list item, so a shelf reads as a list. */
export function CardItem(props: { children: ReactNode }) {
  return (
    <div role="listitem" className="mk-card-item">
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
