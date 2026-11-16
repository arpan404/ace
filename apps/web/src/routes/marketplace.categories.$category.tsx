import { createFileRoute } from "@tanstack/react-router";
import { MarketCategoryScreen } from "@/features/marketplace/index.ts";

export const Route = createFileRoute("/marketplace/categories/$category")({ component: Category });

function Category() {
  const { category } = Route.useParams();
  return <MarketCategoryScreen key={category} category={category} />;
}
