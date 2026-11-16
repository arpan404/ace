import { createFileRoute } from "@tanstack/react-router";
import { MarketInstalledScreen } from "@/features/marketplace/index.ts";

export const Route = createFileRoute("/marketplace/installed")({
  component: MarketInstalledScreen,
});
