import { useEffect, useRef, useState, type UIEvent } from "react";
import { Screen, ViewFrame } from "@/features/shell/index.ts";
import { part } from "@/lib/suit-part.ts";
import { useNow } from "@/lib/time.ts";
import "./market-frame.css";
import "./market-visuals.css";
import "./market-pages.css";
import "./market-people.css";
import "./market-review.css";
import "./market-widths.css";
import "./market-store.css";
import { formatMarket, parseMarket, type MarketView } from "./market-address.ts";
import { useMarketChanges, useMarketSources } from "./market-api.ts";
import { readAtText } from "./market-model.ts";
import { MarketNavContext, type MarketNav } from "./market-nav.ts";
import { MarketLayer } from "./market-page.tsx";
import { MarketSidebar } from "./market-sidebar.tsx";
import { TryBar, useTryOn } from "./market-try.tsx";

/*
 * The Marketplace as a full page (ADR 0168 §12), as pull requests are: its panel (search, the
 * places, Installed) beside the page in the main column. Where it is lives in the address
 * (`/market?at=bot/inbox`), so links, reloads and Back work; each page replaces the one before.
 * ⌘[ goes back a page, as the browser's Back does.
 */

const home: MarketView = { place: "discover", scope: "all", installed: "all", pages: [] };

export function MarketScreen(props: {
  /** The `at` value: where in the Marketplace (`market-address.ts`); home when absent. */
  at: string | undefined;
  /** Moves the address to `value`, as a new entry or in place. */
  onMove(value: string, replace: boolean): void;
  /** The browser's Back: to the page the person came from. */
  onBack(): void;
}) {
  useMarketChanges();
  const view = parseMarket(props.at ?? "discover") ?? home;
  const at = formatMarket(view);
  const [query, setQuery] = useState("");
  const [edge, setEdge] = useState(false);
  const [notice, setNotice] = useState<string>();
  const tryOn = useTryOn(setNotice);
  // How many pages the person pushed here: Back returns to where they were (Installed, a
  // search) while there are any, and to the page's parent for a link that landed straight on it.
  const pushed = useRef(0);
  const move = (next: MarketView, replace = false) => {
    setQuery("");
    setEdge(false);
    props.onMove(formatMarket(next), replace);
  };
  const sources = useMarketSources().data?.sources;
  const market = sources?.find((source) => source.kind === "market");
  const offline = market?.problem !== undefined;
  const now = useNow();
  const nav: MarketNav = {
    view,
    offline,
    go: (place) => move({ ...view, place, pages: [] }),
    push: (page) => {
      pushed.current += 1;
      move({ ...view, pages: [...view.pages, page] });
    },
    back: () => {
      if (pushed.current > 0) {
        pushed.current -= 1;
        setQuery("");
        props.onBack();
      } else move({ ...view, pages: view.pages.slice(0, -1) }, true);
    },
    popTo: (depth) => move({ ...view, pages: view.pages.slice(0, depth) }),
    replace: (page) => move({ ...view, pages: [...view.pages.slice(0, -1), page] }, true),
    setInstalled: (tab) => move({ ...view, place: "installed", installed: tab, pages: [] }),
    // A page has nothing to close: back to the Marketplace's home.
    close: () => move(home),
    tryOn: (entry, title, publisher) => {
      setNotice(undefined);
      void tryOn.start(entry, title, publisher);
    },
  };

  // A search is typed over the place it was typed in; over a page or Installed, it opens Home.
  const onQuery = (next: string) => {
    if (next && (view.pages.length || view.place === "installed")) {
      props.onMove(formatMarket({ ...view, place: "discover", pages: [] }), true);
    }
    setQuery(next);
  };

  // ⌘[ (and ⌥←) back a page; Esc while trying a Suit on puts the person's look back.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (tryOn.trying && event.key === "Escape") {
        event.preventDefault();
        tryOn.undo();
        return;
      }
      const back =
        ((event.metaKey || event.ctrlKey) && event.key === "[") ||
        (event.altKey && event.key === "ArrowLeft");
      if (back && view.pages.length) {
        event.preventDefault();
        nav.back();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  // Leaving the Marketplace while trying a Suit on puts the person's look back.
  useEffect(() => () => tryOn.undo(), []);

  const keep = () => {
    const trying = tryOn.trying;
    if (!trying || tryOn.keep()) return;
    nav.push({ kind: "review", entry: trying.entry, update: false });
  };
  const onScroll = (event: UIEvent<HTMLElement>) => setEdge(event.currentTarget.scrollTop > 4);
  const top = view.pages.at(-1);
  return (
    <MarketNavContext value={nav}>
      <ViewFrame
        label="Marketplace"
        sidebar={<MarketSidebar query={query} onQuery={onQuery} />}
        place="sidebar"
      >
        <Screen page={top ? "market-entry" : "marketplace"} title="Marketplace">
          <div className="contents" data-market-trying={tryOn.trying ? "" : undefined}>
            <div
              role="region"
              aria-label="Marketplace"
              {...part("page", undefined, "market")}
              className="mk-modal"
              data-page=""
              data-edge={edge ? "" : undefined}
            >
              {offline && (
                <p className="mk-offline">
                  <b>Offline.</b>
                  {market?.readAt !== undefined
                    ? ` Showing the catalogue from ${readAtText(market.readAt, now)}.`
                    : ""}{" "}
                  Installs and updates wait until you're back.
                </p>
              )}
              {notice && (
                <p className="mk-offline" role="alert">
                  {notice}
                </p>
              )}
              <div className="mk-stack">
                <section key={at} className="mk-view" onScroll={onScroll}>
                  <MarketLayer view={view} query={query.trim()} />
                </section>
              </div>
            </div>
            <TryBar trying={tryOn.trying} onUndo={tryOn.undo} onKeep={keep} />
          </div>
        </Screen>
      </ViewFrame>
    </MarketNavContext>
  );
}
