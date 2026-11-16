import { createFileRoute } from "@tanstack/react-router";
import { MarketHomeScreen } from "@/features/marketplace/index.ts";

/** Featured, or what the panel's search finds. */
export const Route = createFileRoute("/marketplace/")({ component: MarketHomeScreen });
