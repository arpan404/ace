import { createFileRoute } from "@tanstack/react-router";
import { NewDeckScreen } from "@/features/deck/index.ts";

/** ⌘⇧N: a goal and a few policies start an offset. */
export const Route = createFileRoute("/offsets/new")({ component: NewDeckScreen });
