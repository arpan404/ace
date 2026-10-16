import { renderHandoff } from "@ace/handoff";
import type { CommandId, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { handoff } from "./transition-history.ts";

export type AccountContinuation =
  | { nativeSessionId: string; instanceId: string }
  | { portable: true; instanceId: string };

/** Continue through the existing handoff owner when native history cannot be copied. */
export function continueOnAccount(
  repo: EngineRepository,
  id: ThreadId,
  commandId: CommandId,
  result: AccountContinuation,
  now: number,
): void {
  repo.store.atomic((db) => {
    const metadata = repo.transitions.get(id);
    const session = repo.session(id);
    const current = metadata.selection ?? {
      provider: repo.requireState(id).config.provider,
      options: {},
      ...session,
    };
    const selection = { ...current, instanceId: result.instanceId };
    const portable =
      "portable" in result
        ? handoff(repo, id, repo.store.headSeq(), 16384, current.provider)
        : undefined;
    if (portable) {
      db.prepare("UPDATE engine_sessions SET native_session_id=NULL WHERE thread_id=?").run(id);
      delete metadata.fork;
      metadata.handoff = portable;
      repo.syntheticInput(
        id,
        `handoff:${commandId}`,
        renderHandoff(portable),
        {
          kind: "handoff",
          commandId,
          from: { provider: current.provider, model: current.model },
          to: { provider: selection.provider, model: selection.model },
          lossy: true,
          threadIds: [id],
        },
        now,
      );
    }
    repo.nativeSession(
      id,
      "nativeSessionId" in result ? result.nativeSessionId : undefined,
      repo.backend(id),
      result.instanceId,
    );
    repo.transitions.set(id, { ...metadata, selection });
    repo.transitions.remember(id, selection);
    repo.store.appendEvents(
      id,
      [
        {
          type: "thread.updated",
          execution: selection,
          switch: { selection, state: "applied", lossy: !!portable, at: now },
        },
      ],
      now,
    );
  });
}
