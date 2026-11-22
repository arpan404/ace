import { useSpace } from "@/features/ace-account/index.ts";
import { usePoolProjects } from "@/lib/pool-projects.ts";

/**
 * The window's organization while its hosts hold no projects (ADR 0206 §2.4), once its hosts and
 * their lists are read; undefined in Personal, while a list is out, or with any project there.
 */
export function useEmptyOrgSpace(): string | undefined {
  const { shown, hostsOf } = useSpace();
  const org = shown?.org;
  const { lists, loaded } = usePoolProjects();
  // Until its hosts are known it has no machines yet, not no projects.
  if (!org || !hostsOf.has(org.id) || !loaded) return undefined;
  return lists.some((list) => list.projects.length > 0) ? undefined : org.name;
}

/** Whether the window's chosen organization is still being checked: nothing is drawn meanwhile. */
export function useSpaceChecking(): boolean {
  return useSpace().shown === undefined;
}
