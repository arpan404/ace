import { createFileRoute } from "@tanstack/react-router";
import { NewDeckScreen } from "@/features/deck/index.ts";

/** ⌘⇧N: a goal and a few policies start a deck. */
export const Route = createFileRoute("/deck/new")({ component: NewDeckScreen });
