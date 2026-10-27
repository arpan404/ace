import type { Turn } from "./turns.ts";

/*
 * Which changes a Changes view shows: the checkout's uncommitted work, the last turn's edits, one
 * turn's, or every turn's in the thread. The web tab and the native sheets resolve a requested
 * scope the same way. Pure.
 */

export type DiffScope = "working-tree" | "last" | "all" | (string & {});

export function scopeLabel(scope: DiffScope, turns: readonly Turn[]): string {
  if (scope === "working-tree") return "Uncommitted";
  if (scope === "all") return "This thread";
  if (scope === "last") return "Last turn";
  const turn = turns.find((candidate) => candidate.id === scope);
  return turn ? `Turn ${turn.number}` : "Last turn";
}

/** The turns that edited files: the ones a scope can name. */
export const editedTurns = (turns: readonly Turn[]): Turn[] =>
  turns.filter((turn) => turn.edits.length);

export interface ResolvedScope {
  scope: DiffScope;
  /** The one turn shown; undefined for the working tree and the whole thread. */
  turn: Turn | undefined;
}

/**
 * The scope shown for `requested` over the edited turns: the working tree when no turn edited
 * anything or it was asked for, the whole thread, a turn that still exists, else the last turn.
 */
export function resolveScope(requested: DiffScope, edited: readonly Turn[]): ResolvedScope {
  const scope =
    !edited.length || requested === "working-tree"
      ? "working-tree"
      : requested === "all" || edited.some((turn) => turn.id === requested)
        ? requested
        : "last";
  const turn =
    scope === "all" || scope === "working-tree"
      ? undefined
      : (edited.find((candidate) => candidate.id === scope) ?? edited.at(-1));
  return { scope, turn };
}

/** The edits a resolved scope shows; the working tree has none (it reads the checkout). */
export function scopeEdits(resolved: ResolvedScope, edited: readonly Turn[]): Turn["edits"] {
  if (resolved.scope === "working-tree") return [];
  return resolved.turn ? resolved.turn.edits : edited.flatMap((each) => each.edits);
}
