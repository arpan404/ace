import type { ClientApi } from "@ace/client";
import type { KeyValueStorage } from "@ace/ui-core";
import { chatChoice } from "@/lib/chat-choice.ts";
import type { Machine } from "@/lib/machines.ts";
import { projectOrigin, projectWithOrigin } from "@/lib/project-origin.ts";
import { copiedTo } from "./copied-projects.ts";

/** Whether the machine `client` reaches still has the project `id`. */
async function registered(client: ClientApi, id: string): Promise<boolean> {
  try {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "workspace.origin", workspaceId: id },
    });
    return reply.result.kind === "origin";
  } catch {
    return false;
  }
}

/**
 * The project New thread opens on `next` when it moves there from `home`, the machine the
 * project is on: a copy New thread made there before, else `next`'s own checkout of the same
 * repository (matched by `origin`), else the project itself with `from`, so sending copies it
 * there. A chat needs no project there, and moving back home needs no copy.
 */
export async function projectOn(
  storage: KeyValueStorage | undefined,
  next: Machine,
  project: string,
  home: Machine | undefined,
): Promise<{ project: string; from?: string }> {
  if (project === chatChoice || !home || next.id === home.id) return { project };
  const copied = copiedTo(storage, home.id, project, next.id);
  if (copied && next.client && (await registered(next.client, copied))) return { project: copied };
  const url = home.client ? await projectOrigin(home.client, project) : undefined;
  const copy = url && next.client ? await projectWithOrigin(next.client, url) : undefined;
  return copy ? { project: copy } : { project, from: home.id };
}
