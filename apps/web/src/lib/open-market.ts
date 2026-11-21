import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/*
 * Opens the Marketplace's page at `where` (`/market?at=…`, its address in
 * features/marketplace/market-address.ts). Here so any slice (Spade, Appearance, Skills) can open
 * it without importing the marketplace's code.
 */

/** A `?market=` value: a place (`discover`, `looks`, `bots`, `tools`, `apps`, `installed`), `spade`, or `bot/inbox`. */
export type MarketWhere = string;

export function useOpenMarket() {
  const navigate = useNavigate();
  return useCallback(
    (where: MarketWhere = "discover") =>
      void navigate({ to: "/market", search: where === "discover" ? {} : { at: where } }),
    [navigate],
  );
}
