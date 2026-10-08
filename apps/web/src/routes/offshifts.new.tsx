import { createFileRoute } from "@tanstack/react-router";
import { NewDeckScreen } from "@/features/deck/index.ts";

/** ⌘⇧N: a goal and a few policies start an offshift. */
export const Route = createFileRoute("/offshifts/new")({ component: NewDeckScreen });
