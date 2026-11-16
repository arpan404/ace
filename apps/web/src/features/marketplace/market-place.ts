import { useNavigate, useSearch } from "@tanstack/react-router";
import { marketFilters, type MarketFilter } from "./market-model.ts";

/** The Marketplace's address: `q` is the panel's search, `type` its filter (absent: Everything). */
export interface MarketSearch {
  q?: string | undefined;
  type?: MarketFilter | undefined;
}

const isFilter = (value: unknown): value is MarketFilter =>
  marketFilters.some((filter) => filter === value);

/**
 * The place's search and filter, read from the address so a link from Spade or Appearance opens
 * it filtered, and every row keeps the filter as the person moves around.
 */
export function useMarketPlace() {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const navigate = useNavigate();
  const filter: MarketFilter = isFilter(search["type"]) ? search["type"] : "all";
  const query = typeof search["q"] === "string" ? search["q"] : "";
  const filterSearch: MarketSearch = filter === "all" ? {} : { type: filter };
  return {
    filter,
    query,
    filterSearch,
    setFilter: (next: MarketFilter) =>
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          type: next === "all" ? undefined : next,
        }),
        replace: true,
      }),
  };
}
