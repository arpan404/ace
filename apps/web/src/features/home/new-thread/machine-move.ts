import { chatChoice } from "@/lib/chat-choice.ts";
import type { Machine } from "@/lib/machines.ts";
import { projectOrigin, projectWithOrigin } from "@/lib/project-origin.ts";

/**
 * The project New thread opens on `next` when it moves there from `home`, the machine the
 * project is on: `next`'s own copy of the same repository (matched by `origin`), else the
 * project itself with `from`, so sending copies it there. A chat needs no project there, and
 * moving back home needs no copy.
 */
export async function projectOn(
  next: Machine,
  project: string,
  home: Machine | undefined,
): Promise<{ project: string; from?: string }> {
  if (project === chatChoice || !home || next.id === home.id) return { project };
  const url = home.client ? await projectOrigin(home.client, project) : undefined;
  const copy = url && next.client ? await projectWithOrigin(next.client, url) : undefined;
  return copy ? { project: copy } : { project, from: home.id };
}
