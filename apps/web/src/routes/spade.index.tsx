import { createFileRoute } from "@tanstack/react-router";
import { SpadeNewScreen } from "@/features/spade/index.ts";

/** A new Spade conversation: the first message starts it. */
export const Route = createFileRoute("/spade/")({ component: SpadeNewScreen });
