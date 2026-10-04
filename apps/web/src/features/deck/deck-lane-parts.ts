import { lazy } from "react";
import type { ThreadParts } from "@/features/panels/index.ts";

/*
 * Deck's views for a thread's workspace tabs (a lane, the thread's deck in Agents), loaded the
 * first time one shows: the thread route hands these to the panels, so neither the thread
 * screen nor the shell carries Deck's code.
 */
const views = () => import("./deck-lane-tab.tsx");

export const deckLaneParts: ThreadParts = {
  DeckLane: lazy(() => views().then((m) => ({ default: m.DeckLaneTab }))),
  DeckOfThread: lazy(() => views().then((m) => ({ default: m.DeckOfThread }))),
};
