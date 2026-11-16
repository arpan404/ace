import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod/mini";
import { MarketReviewScreen } from "@/features/marketplace/index.ts";

/** `?update=1` reviews the newer version of an installed entry. */
const Search = z.object({ update: z.catch(z.optional(z.literal(1)), undefined) });

/** The review before an install or an update, whose last action is Install. */
export const Route = createFileRoute("/marketplace/$source/$type/$name_/review")({
  validateSearch: Search,
  component: Review,
});

function Review() {
  const { source, type, name } = Route.useParams();
  const { update } = Route.useSearch();
  return (
    <MarketReviewScreen
      key={`${source}/${type}/${name}/${update ?? 0}`}
      entry={{ source, type, name }}
      update={update === 1}
    />
  );
}
