// Thread transitions (ADR 0051) as daemon commands, the same in fake mode, where the fake daemon
// answers them. Each resolves once the daemon has accepted it and rejects with `CommandRefused`
// when it says no. Organization (rename, settle, snooze, pin, archive, delete) is
// `features/organize`, shared with Home.
import type { ClientApi } from "@ace/client";
import { ThreadId, type CommandPayload, type ForkPoint } from "@ace/protocol";
import { runCommand } from "@/lib/daemon-command.ts";
import type { ThreadRef } from "./workspace-source.ts";

/** Provider, model and account a thread continues on after a switch (or a fork starts on). */
export type Selection = Extract<CommandPayload, { type: "thread.switch" }>["selection"];

export interface ThreadActionsSource {
  /** A new thread continuing from `point` with `input` as its first message; its id. */
  fork(
    thread: ThreadRef,
    fork: { point: ForkPoint; input: string; selection?: Selection | undefined },
  ): Promise<string>;
  /** Continue on another provider, model or account from the next turn. */
  switchTo(thread: ThreadRef, selection: Selection): Promise<void>;
}

const id = (thread: ThreadRef) => ThreadId.parse(thread.id);

export function daemonThreadActions(client: ClientApi): ThreadActionsSource {
  const run = async (payload: CommandPayload) => {
    await runCommand(client, payload);
  };
  return {
    async fork(thread, fork) {
      const result = await runCommand(client, {
        type: "thread.fork",
        threadId: id(thread),
        point: fork.point,
        input: fork.input,
        budgetBytes: 16384,
        ...(fork.selection
          ? { selection: { ...fork.selection, options: fork.selection.options ?? {} } }
          : {}),
      });
      if (!result.forkThreadId) throw new Error("ace didn't say which thread it created.");
      return result.forkThreadId;
    },
    switchTo: (thread, selection) =>
      run({ type: "thread.switch", threadId: id(thread), selection }),
  };
}
