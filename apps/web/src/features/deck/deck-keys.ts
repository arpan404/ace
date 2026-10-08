import { useToast } from "@/components/ui/toast.tsx";

/*
 * WP-1: stand-ins until the shared foundation lands. The deck shortcuts become the keymap ids
 * WP-1 pre-declares in lib/keymap.ts (deckPlan, deckLanes, deckApprove, deckNextCard,
 * deckPrevCard) and resolve through `useKeys(id)`, so rebinding applies; error toasts become
 * `toast.error()`. Swap these call sites over and delete this file.
 */

/** Deck's own shortcuts, in keymap notation. */
export const deckKeys = {
  deckPlan: { keys: "g p", label: "Show the plan" },
  deckLanes: { keys: "g l", label: "Show the lanes" },
  deckApprove: { keys: "mod+enter", label: "Approve" },
  deckNextCard: { keys: "j", label: "Next card" },
  deckPrevCard: { keys: "k", label: "Previous card" },
} as const;

/** Toasts for deck commands: a confirmation, or an error announced as one. */
export function useDeckToast(): { done(title: string): void; error(title: string): void } {
  const toast = useToast();
  return {
    done: (title) => toast.add({ title }),
    // WP-1: toast.error(title)
    error: (title) => toast.add({ title, type: "error", priority: "high" }),
  };
}

/** A command's failure as a sentence: the daemon's refusal, or that it didn't answer. */
export function failure(error: unknown): string {
  return error instanceof Error ? error.message : "The offshift didn't answer.";
}
