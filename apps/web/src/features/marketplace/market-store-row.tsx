import type { MarketEntrySummary, MarketInstalled } from "@ace/protocol/marketplace";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAppConnect } from "@/features/spade/index.ts";
import { part } from "@/lib/suit-part.ts";
import { sameEntry, type MarketEntryKey } from "./market-address.ts";
import { useMarketInstalled } from "./market-api.ts";
import { appLine, type StoreApp } from "./market-app-model.ts";
import { offlineTitle, openEntry, useMarketNav } from "./market-nav.ts";
import { Stage } from "./market-stage.tsx";

/*
 * The row every store list is made of: the entry's icon (a bot's face, a Suit's window, a tool's
 * glyph, an app's mark), its name and one line, and its one button at the right: Get, Update or
 * Open for an entry, Connect or Reconnect for an app. The words open its page; the button acts
 * without opening it. Shelves are titled lists of these rows.
 */

export const entryKeyOf = (entry: MarketEntryKey) =>
  `${entry.source}/${entry.type}/${entry.name}`;

export function EntryIcon(props: { entry: MarketEntrySummary; size?: "row" | "page" }) {
  return (
    <span className="st-icon" data-size={props.size} aria-hidden>
      <Stage entry={props.entry} size={props.size === "page" ? "card" : "small"} />
    </span>
  );
}

export function AppIcon(props: { app: Pick<StoreApp, "catalogue" | "name">; size?: "row" | "page" }) {
  return (
    <span className="st-icon" data-kind="app" data-size={props.size} aria-hidden>
      <AppMark
        catalogue={props.app.catalogue}
        name={props.app.name}
        size={props.size === "page" ? "hero" : "store"}
      />
    </span>
  );
}

/** The entry's installed copy, if any. */
export function useInstalledCopy(entry: MarketEntryKey): MarketInstalled | undefined {
  return useMarketInstalled().data?.installed.find((item) => sameEntry(item, entry));
}

/**
 * An entry's one button: Get (to its short review), Update (to the update's review), or Open
 * for a bot that's installed (to its chat). Something installed with nothing to open says so.
 */
export function GetButton(props: {
  entry: MarketEntryKey & { title: string; type: string };
  size?: "sm" | "lg";
  /** A page's one primary action; rows' buttons are secondary. */
  primary?: boolean;
}) {
  const nav = useMarketNav();
  const navigate = useNavigate();
  const copy = useInstalledCopy(props.entry);
  const size = props.size ?? "sm";
  const variant = props.primary ? "primary" : "secondary";
  const key = { source: props.entry.source, type: props.entry.type, name: props.entry.name };
  if (copy && !copy.update) {
    const bot = props.entry.type === "spade-bot" ? copy.target : undefined;
    if (!bot) return <span className="st-state">Installed</span>;
    return (
      <Button
        size={size}
        variant={variant}
        aria-label={`Open ${props.entry.title}`}
        onClick={() => {
          nav.close();
          void navigate({ to: "/spade/$agentId", params: { agentId: bot } });
        }}
      >
        Open
      </Button>
    );
  }
  const word = copy?.update ? "Update" : "Get";
  return (
    <Button
      size={size}
      variant={variant}
      aria-label={`${word} ${props.entry.title}`}
      disabled={nav.offline}
      title={nav.offline ? offlineTitle(word) : undefined}
      onClick={() => nav.push({ kind: "review", entry: key, update: word === "Update" })}
    >
      {word}
    </Button>
  );
}

/** One entry as a row: icon, name, line, and its button. */
export function EntryRow(props: { entry: MarketEntrySummary; line?: string | undefined }) {
  const nav = useMarketNav();
  const { entry } = props;
  return (
    <li {...part("list-row", undefined, "market")} className="st-row">
      <EntryIcon entry={entry} />
      <div className="st-row-main">
        <button
          type="button"
          className="st-row-open"
          aria-label={entry.title}
          onClick={() => openEntry(nav, entry)}
        >
          <span className="st-name">{entry.title}</span>
          <span className="st-line">{props.line ?? entry.line}</span>
        </button>
        <GetButton entry={entry} />
      </div>
    </li>
  );
}

/** One app as a row: its mark, name and state, and Connect or Reconnect right there. */
export function AppRow(props: { app: StoreApp; line?: string | undefined }) {
  const nav = useMarketNav();
  const { app } = props;
  const connect = useAppConnect({
    app: {
      catalogue: app.catalogue,
      name: app.name,
      connector: app.state === "signed_out" ? app.connector : undefined,
      ready: app.ready,
      keyUrl: app.keyUrl,
    },
    size: "sm",
  });
  const open = () => nav.push({ kind: "app", id: app.id });
  const settled = app.state === "connected" || app.state === "unreachable";
  return (
    <li {...part("list-row", undefined, "market-app")} className="st-row" style={{ flexWrap: "wrap" }}>
      <AppIcon app={app} />
      <div className="st-row-main">
        <button type="button" className="st-row-open" aria-label={app.name} onClick={open}>
          <span className="st-name">{app.name}</span>
          <span className="st-line">{props.line ?? appLine(app)}</span>
        </button>
        {settled || app.state === "connecting" ? (
          <Button size="sm" variant="secondary" aria-label={`Open ${app.name}`} onClick={open}>
            Open
          </Button>
        ) : app.state === "later" ? (
          <span className="st-state">Not yet</span>
        ) : (
          connect.action
        )}
      </div>
      {connect.status && (
        <div className="st-row-status" style={{ flexBasis: "100%" }}>
          {connect.status}
        </div>
      )}
    </li>
  );
}

/** A list of rows in up to three columns (`cols` caps it; narrower widths take fewer). */
export function StoreRows(props: { label: string; cols?: 1 | 2 | 3; children: ReactNode }) {
  return (
    <ul className="st-rows" aria-label={props.label} data-cols={props.cols}>
      {props.children}
    </ul>
  );
}

/** A titled shelf, with See all when it has a place of its own. */
export function Shelf(props: { title: string; all?: (() => void) | undefined; children: ReactNode }) {
  return (
    <section {...part("page-section", undefined, "market")} className="st-shelf" aria-label={props.title}>
      <div className="st-shelf-head">
        <h2 {...part("section-title", undefined, "market")} className="st-h2">
          {props.title}
        </h2>
        {props.all && (
          <button type="button" {...part("link")} className="st-all" onClick={props.all}>
            See all
          </button>
        )}
      </div>
      {props.children}
    </section>
  );
}
