// Slash commands from the daemon's command library (`commands.list`): the provider CLI's own
// commands, the project's prompt files and ace's built-ins, for the thread's provider.
import type { Client } from "@ace/client";
import { ThreadId, type PaletteCommand } from "@ace/protocol";
import type { ThreadRef } from "./workspace-source.ts";

export interface SlashCommand {
  /** Without the slash, e.g. "review". */
  name: string;
  description: string;
  /** Where it comes from: the provider CLI, a prompt file or skill, or ace itself. */
  source: "provider" | "skill" | "ace";
  /** Placeholder for the argument, shown after the command. */
  argument?: string | undefined;
}

export interface CommandSource {
  commands(thread: ThreadRef, signal?: AbortSignal): Promise<readonly SlashCommand[]>;
}

const sources: Record<PaletteCommand["namespace"], SlashCommand["source"]> = {
  provider: "provider",
  prompt: "skill",
  ace: "ace",
};

/** Matches by prefix first, then anywhere in the name. */
export function matchCommands(list: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix = list.filter((command) => command.name.startsWith(q));
  const inner = list.filter((command) => !command.name.startsWith(q) && command.name.includes(q));
  return [...prefix, ...inner];
}

export function daemonCommandSource(client: Client): CommandSource {
  return {
    async commands(thread, signal) {
      // TODO(client-gaps): feat/client-protocol-gaps. A thread that doesn't exist yet (New
      // thread) has no scope to ask in until the daemon offers a pre-thread draft scope.
      if (thread.draft) return [];
      const reply = await client.request(
        { type: "commands.list", threadId: ThreadId.parse(thread.id), limit: 100 },
        signal ? { signal } : {},
      );
      return reply.commands.map((command) => ({
        name: command.name,
        description: command.description,
        source: sources[command.namespace],
        argument: command.argumentHint,
      }));
    },
  };
}
