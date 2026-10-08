import { createFileRoute } from "@tanstack/react-router";
import { DeckLandingScreen } from "@/features/deck/index.ts";

/** Offshifts opens on the one that most needs a look: gated first, then active, then the latest. */
export const Route = createFileRoute("/offshifts/")({ component: DeckLandingScreen });
