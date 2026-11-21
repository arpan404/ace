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

/** The project's folder inside its repository; "" at its top, or from a daemon older than it. */
async function projectSubpath(client: ClientApi, project: string): Promise<string> {
  try {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "workspace.checkout", workspaceId: project },
    });
    return reply.result.kind === "checkout" ? reply.result.checkout.subpath : "";
  } catch {
    return "";
  }
}

/**
 * Where New thread lands for `project`, on the machine `home` it is on, when it moves to each
 * other machine: its own checkout there of the same logical project (`sameProject`, ADR 0180),
 * else a copy New thread made there before, else that machine's own checkout of the same
 * repository (matched by `origin` at the same folder inside it), else the project itself with
 * `from`, so sending copies it there. A chat needs no project there, and moving back home needs
 * no copy. A machine that keeps no identities is matched only the older ways.
 *
 * Each machine's answer is asked once and kept, and the project's own origin is read once for
 * all of them, so the menu can ask ahead (`resolve` as it opens) and a pick moves at once.
 */
export function moveResolver(
  storage: KeyValueStorage | undefined,
  project: string,
  home: Machine | undefined,
  sameProject: (next: Machine) => string | undefined = () => undefined,
): { resolve(next: Machine): Promise<Move> } {
  const moves = new Map<string, Promise<Move>>();
  let origin: Promise<Awaited<ReturnType<typeof projectOrigin>>> | undefined;
  const originOnce = () =>
    (origin ??= home?.client ? projectOrigin(home.client, project) : Promise.resolve(undefined));
  let subpath: Promise<string> | undefined;
  const subpathOnce = () =>
    (subpath ??= home?.client ? projectSubpath(home.client, project) : Promise.resolve(""));
  const ask = async (next: Machine): Promise<Move> => {
    if (project === chatChoice || !home || next.id === home.id) return { project };
    const linked = sameProject(next);
    if (linked) return { project: linked };
    const client = next.client;
    const copied = copiedTo(storage, home.id, project, next.id);
    // The earlier copy and the same repository there are asked for together.
    const [kept, same] = await Promise.all([
      copied && client ? registered(client, copied) : false,
      Promise.all([originOnce(), subpathOnce()]).then(([found, folder]) =>
        found && client ? projectWithOrigin(client, found, folder) : undefined,
      ),
    ]);
    if (copied && kept) return { project: copied };
    return same ? { project: same } : { project, from: home.id };
  };
  return {
    resolve(next) {
      // A link made meanwhile answers at once, ahead of an older ask kept for this machine.
      const linked = project !== chatChoice && next.id !== home?.id ? sameProject(next) : undefined;
      if (linked) return Promise.resolve({ project: linked });
      let move = moves.get(next.id);
      if (!move) {
        move = ask(next);
        moves.set(next.id, move);
      }
      return move;
    },
  };
}
