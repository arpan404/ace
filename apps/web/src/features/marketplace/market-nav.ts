import { createContext, useContext } from "react";
import type { MarketEntryKey, MarketPage, MarketPlace, MarketView } from "./market-address.ts";

/*
 * How a page inside the Marketplace modal moves: push a page over the place, go back, change
 * place, close, and try a Suit on. The modal provides it; pages only call it.
 */

export interface MarketNav {
  view: MarketView;
  /** The listings couldn't be read again: what installs or connects waits until they can. */
  offline: boolean;
  go(place: MarketPlace): void;
  push(page: MarketPage): void;
  /** Back one page (⌘[). */
  back(): void;
  /** Back to `depth` pages over the place (0 is the place itself). */
  popTo(depth: number): void;
  /** Replaces the top page, keeping the history under it (an install landing back on its entry). */
  replace(page: MarketPage): void;
  setInstalled(tab: MarketView["installed"]): void;
  close(): void;
  /** Hides the modal and dresses the whole app in the Suit, with Undo and Keep it. */
  tryOn(entry: MarketEntryKey, title: string, publisher: string | undefined): void;
}

export const MarketNavContext = createContext<MarketNav | undefined>(undefined);

export function useMarketNav(): MarketNav {
  const nav = useContext(MarketNavContext);
  if (!nav) throw new Error("useMarketNav outside the Marketplace modal");
  return nav;
}

/** Pushes an entry's page. */
export const openEntry = (nav: MarketNav, entry: MarketEntryKey) =>
  nav.push({ kind: "entry", entry });

/** The words a disabled action shows while offline. */
export const offlineTitle = (what: string) => `${what} when you're back online`;
