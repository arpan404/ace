import { createFileRoute } from "@tanstack/react-router";
import { MarketUpdatesScreen } from "@/features/marketplace/index.ts";

export const Route = createFileRoute("/marketplace/updates")({ component: MarketUpdatesScreen });
