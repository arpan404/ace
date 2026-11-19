import { createFileRoute } from "@tanstack/react-router";
import { SpadeHomeScreen } from "@/features/spade/index.ts";

/** Spade's place: opens Spade's own conversation. */
export const Route = createFileRoute("/spade/")({ component: SpadeHomeScreen });
