// Thread organization (ADR 0057) and transitions (ADR 0051) as daemon commands, the same in fake
// mode, where the fake daemon answers them. Each resolves once the daemon has accepted it and
// rejects with `CommandRefused` when it says no.
import type { ClientApi } from "@ace/client";
import { ThreadId, type CommandPayload, type ForkPoint } from "@ace/protocol";
import { runCommand } from "@/lib/daemon-command.ts";
import type { ThreadRef } from "./workspace-source.ts";

/** Provider, model and account a thread continues on after a switch (or a fork starts on). */
export type Selection = Extract<CommandPayload, { type: "thread.switch" }>["selection"];

export interface ThreadActionsSource {
  rename(thread: ThreadRef, title: string): Promise<void>;
  /** A new thread continuing from `point` with `input` as its first message; its id. */
  fork(
    thread: ThreadRef,
    fork: { point: ForkPoint; input: string; selection?: Selection | undefined },
  ): Promise<string>;
  /** Continue on another provider, model or account from the next turn. */
  switchTo(thread: ThreadRef, selection: Selection): Promise<void>;
  settle(thread: ThreadRef): Promise<void>;
  unsettle(thread: ThreadRef): Promise<void>;
  /** Absolute time, or null to wake now. */
  snooze(thread: ThreadRef, until: number | null): Promise<void>;
  pin(thread: ThreadRef, pinned: boolean): Promise<void>;
  archive(thread: ThreadRef): Promise<void>;
  unarchive(thread: ThreadRef): Promise<void>;
  /** Permanent: the daemon keeps a tombstone and refuses further work. */
  remove(thread: ThreadRef): Promise<void>;
}

const id = (thread: ThreadRef) => ThreadId.parse(thread.id);

export function daemonThreadActions(client: ClientApi): ThreadActionsSource {
  const run = async (payload: CommandPayload) => {
    await runCommand(client, payload);
  };
  return {
    rename: (thread, title) => run({ type: "thread.rename", threadId: id(thread), title }),
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
      if (!result.forkThreadId) throw new Error("The daemon didn't say which thread it created.");
      return result.forkThreadId;
    },
    switchTo: (thread, selection) =>
      run({ type: "thread.switch", threadId: id(thread), selection }),
    settle: (thread) => run({ type: "thread.settle", threadId: id(thread) }),
    unsettle: (thread) => run({ type: "thread.unsettle", threadId: id(thread) }),
    snooze: (thread, until) => run({ type: "thread.snooze", threadId: id(thread), until }),
    pin: (thread, pinned) => run({ type: "thread.pin", threadId: id(thread), pinned }),
    archive: (thread) => run({ type: "thread.archive", threadId: id(thread) }),
    unarchive: (thread) => run({ type: "thread.unarchive", threadId: id(thread) }),
    remove: (thread) => run({ type: "thread.delete", threadId: id(thread) }),
  };
}
