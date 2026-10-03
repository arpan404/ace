import { createFileRoute } from "@tanstack/react-router";
import { DeckLandingScreen } from "@/features/deck/index.ts";

/** Deck opens on the deck that most needs a look: gated first, then active, then the latest. */
export const Route = createFileRoute("/deck/")({ component: DeckLandingScreen });
