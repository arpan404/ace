import type { ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import { useToast } from "@/components/ui/toast.tsx";
import { findRunningTerminal } from "@/features/panels/index.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { Script } from "../sources/workspace-source.ts";
import { useTaskKeys } from "./use-task-keys.ts";

const failure = (error: unknown) =>
  error instanceof Error ? error.message : "ace couldn't do that.";

interface Shell {
  id: string;
  command: string;
}
/** The agents' background shells still running, by the command they run. */
const runningShells = (reader: ThreadReader): Shell[] =>
  reader.taskIds().flatMap((id) => {
    const task = reader.task(id);
    return task?.kind === "shell" && task.status === "running"
      ? [{ id, command: task.title.trim() }]
      : [];
  });
const sameShells = (a: readonly Shell[], b: readonly Shell[]) =>
  a.length === b.length && a.every((shell, i) => shell.id === b[i]?.id);
const noShells: readonly Shell[] = [];

/** The project's scripts (package.json, a Makefile, justfile or Procfile), as the daemon reads them. */
export function useScripts(thread: ThreadRef) {
  const sources = useThreadSources();
  return useDaemonQuery({
    queryKey: ["thread", "scripts", thread.id],
    staleTime: 60_000,
    retry: false,
    read: (_client, signal) => sources.workspace.scripts(thread, signal),
  });
}

/**
 * Run a project script in a terminal tab of the side panel. A script still running goes back to
 * its terminal (or the agent's background shell running the same command) instead of starting a
 * second copy fighting the first for its port. The tab showing is the confirmation.
 */
export function useRunScript(thread: ThreadRef): {
  run(script: Script): Promise<void>;
  /** Commands an agent runs in the background right now. */
  agentCommands: readonly string[];
} {
  const sources = useThreadSources();
  const client = useClient();
  const toast = useToast();
  const workspace = useWorkspaceActions(thread.id);
  const shells =
    useThread(thread.id, useTaskKeys(thread.id), runningShells, sameShells) ?? noShells;
  const run = async (script: Script) => {
    try {
      const agentShell = shells.find((shell) => shell.command === script.command.trim());
      // The workspace's agent-shell and terminal tabs (features/panels/terminal/tabs.ts).
      if (agentShell) return workspace.open({ kind: "shell", id: agentShell.id });
      const running = await findRunningTerminal(client, thread.id, script.name);
      const terminalId = running?.id ?? (await sources.workspace.runScript(thread, script));
      workspace.open({ kind: "terminal", id: terminalId, title: script.name });
    } catch (error) {
      toast.error({ title: `Couldn't run ${script.command}`, description: failure(error) });
    }
  };
  return { run, agentCommands: shells.map((shell) => shell.command) };
}
