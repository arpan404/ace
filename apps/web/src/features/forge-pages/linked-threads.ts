import { useSidebarAll } from "@ace/client-react";
import { linkedWork, type LinkedThreads } from "@ace/ui-core";

const same = (x: LinkedThreads, y: LinkedThreads) =>
  x.size === y.size &&
  [...x].every(([key, thread]) => {
    const other = y.get(key);
    return (
      other?.id === thread.id && other.title === thread.title && other.needsYou === thread.needsYou
    );
  });
const sameLinks = (a: ReturnType<typeof linkedWork>, b: ReturnType<typeof linkedWork>): boolean =>
  same(a.pulls, b.pulls) && same(a.issues, b.issues);

const none = { pulls: new Map(), issues: new Map() } as const;

/** Which PRs and issues the loaded threads are linked to (`linkedWork`), kept while unchanged. */
export function useLinkedThreads(): { pulls: LinkedThreads; issues: LinkedThreads } {
  return useSidebarAll(linkedWork, sameLinks) ?? none;
}
