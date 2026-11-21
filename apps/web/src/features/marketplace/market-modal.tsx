import { useEffect, useRef, useState, type UIEvent } from "react";
import { part } from "@/lib/suit-part.ts";
import { useNow } from "@/lib/time.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import "./market-frame.css";
import "./market-visuals.css";
import "./market-pages.css";
import "./market-people.css";
import "./market-review.css";
import "./market-widths.css";
import "./market-store.css";
import { formatMarket, type MarketView } from "./market-address.ts";
import { useMarketChanges, useMarketSources } from "./market-api.ts";
import { MarketBar } from "./market-bar.tsx";
import { readAtText } from "./market-model.ts";
import { MarketNavContext, type MarketNav } from "./market-nav.ts";
import { MarketLayer } from "./market-page.tsx";
import { TryBar, useTryOn } from "./market-try.tsx";
import { keepTabWithin } from "./market-focus.ts";

/*
 * The Marketplace as a modal over the app (ADR 0168): 90% of the window with the app dimmed
 * behind, a full-screen sheet on a phone. Its bar stays; places swap in place and deeper pages
 * slide in over them with a crumb trail back (⌘[ too). Esc clears a search, else closes. Where
 * it is goes back to the address (`?market=`) as the person moves, so links into it work.
 */

type Motion = "push" | "pop" | "none";
/**
 * The one page on screen. A page replaces the one before it outright: no layer of the old page
 * stays under the new one, so nothing shows through while it arrives (it only slides a little
 * into place on an opaque page).
 */
interface Shown {
  id: number;
  view: MarketView;
  motion: Exclude<Motion, "none"> | undefined;
}

const depthOf = (view: MarketView) => view.pages.length;

export function MarketModal(props: {
  view: MarketView;
  /** Writes where the modal is to the address (replacing the entry). */
  onMove(value: string): void;
  onClose(): void;
}) {
  useMarketChanges();
  const reduce = useTheme().resolved.reduceMotion;
  const [view, setView] = useState(props.view);
  const [query, setQuery] = useState("");
  const [edge, setEdge] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [shown, setShown] = useState<Shown>({ id: 0, view: props.view, motion: undefined });
  const nextId = useRef(1);
  const modal = useRef<HTMLDivElement>(null);
  const tryOn = useTryOn(setNotice);

  const show = (next: MarketView, motion: Motion, nextQuery = "") => {
    setView(next);
    setQuery(nextQuery);
    setEdge(false);
    const value = formatMarket(next);
    if (value !== formatMarket(view)) props.onMove(value);
    const id = nextId.current++;
    setShown({ id, view: next, motion: motion === "none" || reduce ? undefined : motion });
  };

  const close = () => {
    if (tryOn.trying) tryOn.undo();
    if (reduce) return props.onClose();
    setLeaving(true);
    setTimeout(props.onClose, 140);
  };

  const nav: MarketNav = {
    view,
    offline: false,
    go: (place) => show({ ...view, place, pages: [] }, depthOf(view) ? "pop" : "none"),
    push: (page) => show({ ...view, pages: [...view.pages, page] }, "push"),
    back: () => show({ ...view, pages: view.pages.slice(0, -1) }, "pop"),
    popTo: (depth) => show({ ...view, pages: view.pages.slice(0, depth) }, "pop"),
    replace: (page) => show({ ...view, pages: [...view.pages.slice(0, -1), page] }, "none"),
    setInstalled: (tab) => show({ ...view, place: "installed", installed: tab, pages: [] }, "none"),
    close,
    tryOn: (entry, title, publisher) => {
      setNotice(undefined);
      void tryOn.start(entry, title, publisher);
    },
  };

  // Offline: the market's listing couldn't be read again; the copy from `readAt` stays in use.
  const sources = useMarketSources().data?.sources;
  const market = sources?.find((source) => source.kind === "market");
  const offline = market?.problem !== undefined;
  const now = useNow();
  const shownNav: MarketNav = { ...nav, offline };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (tryOn.trying) {
        if (event.key === "Escape") {
          event.preventDefault();
          tryOn.undo();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab" && modal.current) {
        keepTabWithin(modal.current, event);
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

  // Focus moves into the modal as it opens, and back to what had it as it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const onQuery = (next: string) => {
    if (view.pages.length || view.place === "installed")
      show(
        { ...view, place: view.place === "installed" ? "discover" : view.place, pages: [] },
        "none",
        next,
      );
    else setQuery(next);
  };
  const onScroll = (event: UIEvent<HTMLElement>) => setEdge(event.currentTarget.scrollTop > 4);
  const keep = () => {
    const trying = tryOn.trying;
    if (!trying) return;
    if (tryOn.keep()) return;
    show(
      { ...view, pages: [...view.pages, { kind: "review", entry: trying.entry, update: false }] },
      "push",
    );
  };

  return (
    <MarketNavContext value={shownNav}>
      <div data-market-trying={tryOn.trying ? "" : undefined}>
        <div className="mk-scrim" aria-hidden onClick={close} />
        <div
          ref={modal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="market-title"
          tabIndex={-1}
          {...part("dialog", undefined, "market")}
          data-leaving={leaving ? "" : undefined}
          className="mk-modal"
        >
          <MarketBar query={query} onQuery={onQuery} edge={edge} onClose={close} />
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
          <main className="mk-stack">
            <section
              key={shown.id}
              className="mk-view"
              data-motion={shown.motion}
              onScroll={onScroll}
            >
              <MarketLayer view={shown.view} query={query} />
            </section>
          </main>
        </div>
        <TryBar trying={tryOn.trying} onUndo={tryOn.undo} onKeep={keep} />
      </div>
    </MarketNavContext>
  );
}
