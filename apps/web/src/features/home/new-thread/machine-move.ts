import type { ClientApi } from "@ace/client";
import type { KeyValueStorage } from "@ace/ui-core";
import { chatChoice } from "@/lib/chat-choice.ts";
import type { Machine } from "@/lib/machines.ts";
import { projectOrigin, projectWithOrigin } from "@/lib/project-origin.ts";
import { copiedTo } from "./copied-projects.ts";

/** Where New thread lands on another machine: the project there, or the one to copy there. */
export interface Move {
  project: string;
  /** The machine `project` is on, when the other machine doesn't have it: sending copies it. */
  from?: string;
}

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
 * Where New thread lands for `project`, on the machine `home` it is on, when it moves to each
 * other machine: a copy New thread made there before, else that machine's own checkout of the
 * same repository (matched by `origin`), else the project itself with `from`, so sending copies
 * it there. A chat needs no project there, and moving back home needs no copy.
 *
 * Each machine's answer is asked once and kept, and the project's own origin is read once for
 * all of them, so the menu can ask ahead (`resolve` as it opens) and a pick moves at once.
 */
export function moveResolver(
  storage: KeyValueStorage | undefined,
  project: string,
  home: Machine | undefined,
): { resolve(next: Machine): Promise<Move> } {
  const moves = new Map<string, Promise<Move>>();
  let origin: Promise<string | undefined> | undefined;
  const originOnce = () =>
    (origin ??= home?.client ? projectOrigin(home.client, project) : Promise.resolve(undefined));
  const ask = async (next: Machine): Promise<Move> => {
    if (project === chatChoice || !home || next.id === home.id) return { project };
    const client = next.client;
    const copied = copiedTo(storage, home.id, project, next.id);
    // The earlier copy and the same repository there are asked for together.
    const [kept, same] = await Promise.all([
      copied && client ? registered(client, copied) : false,
      originOnce().then((url) => (url && client ? projectWithOrigin(client, url) : undefined)),
    ]);
    if (copied && kept) return { project: copied };
    return same ? { project: same } : { project, from: home.id };
  };
  return {
    resolve(next) {
      let move = moves.get(next.id);
      if (!move) {
        move = ask(next);
        moves.set(next.id, move);
      }
      return move;
    },
  };
}
