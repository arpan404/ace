import { useSpace } from "@/features/ace-account/index.ts";
import { usePoolProjects } from "@/lib/pool-projects.ts";

/**
 * The window's organization while its hosts hold no projects (ADR 0206 §2.4), once their lists
 * are read; undefined in Personal, while a list is out, or with any project there.
 */
export function useEmptyOrgSpace(): string | undefined {
  const org = useSpace().shown?.org;
  const { lists, loaded } = usePoolProjects();
  if (!org || !loaded) return undefined;
  return lists.some((list) => list.projects.length > 0) ? undefined : org.name;
}

/** Whether the window's chosen organization is still being checked: nothing is drawn meanwhile. */
export function useSpaceChecking(): boolean {
  return useSpace().shown === undefined;
}
