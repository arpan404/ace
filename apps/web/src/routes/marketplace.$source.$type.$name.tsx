import { createFileRoute } from "@tanstack/react-router";
import { MarketEntryScreen } from "@/features/marketplace/index.ts";

/** One entry's page, as a pull request's is: the whole main column. */
export const Route = createFileRoute("/marketplace/$source/$type/$name")({ component: Entry });

function Entry() {
  const { source, type, name } = Route.useParams();
  return <MarketEntryScreen key={`${source}/${type}/${name}`} entry={{ source, type, name }} />;
}
