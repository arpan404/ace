import { createFileRoute } from "@tanstack/react-router";
import { MarketCatalogsScreen } from "@/features/marketplace/index.ts";

export const Route = createFileRoute("/marketplace/catalogs")({ component: MarketCatalogsScreen });
