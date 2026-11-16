import { useNavigate } from "@tanstack/react-router";

/*
 * Opens the Marketplace modal over the page the person is on, by setting `?market=` (the modal's
 * address, features/marketplace/market-address.ts). Here so any slice (Spade, Appearance, Skills)
 * can open it without importing the marketplace's code.
 */

/** A `?market=` value: a place (`discover`, `looks`, `bots`, `tools`, `apps`, `installed`), `spade`, or `bot/inbox`. */
export type MarketWhere = string;

export function useOpenMarket() {
  const navigate = useNavigate();
  return (where: MarketWhere = "discover") =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, market: where }),
    });
}
