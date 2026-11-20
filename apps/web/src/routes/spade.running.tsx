import { createFileRoute } from "@tanstack/react-router";
import { SpadeRunningScreen } from "@/features/spade/index.ts";

/** Running (ADR 0200 §6.3): everything Spade runs, with Stop, Pause and Resume on each bot. */
export const Route = createFileRoute("/spade/running")({ component: SpadeRunningScreen });
