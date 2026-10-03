// TODO(train-2): wire to protocol when merged. Slash commands are PR #46.
import type { ThreadRef } from "./workspace-source.ts";

export interface SlashCommand {
  /** Without the slash, e.g. "review". */
  name: string;
  description: string;
  /** Where it comes from: the provider CLI, a skill, or ace itself. */
  source: "provider" | "skill" | "ace";
  /** Placeholder for the argument, shown after the command. */
  argument?: string | undefined;
}

export interface CommandSource {
  commands(thread: ThreadRef): Promise<readonly SlashCommand[]>;
}

const commands: readonly SlashCommand[] = [
  { name: "review", description: "Review the changes on this branch", source: "provider" },
  {
    name: "test",
    description: "Run the tests and fix what fails",
    source: "skill",
    argument: "path",
  },
  { name: "plan", description: "Plan before editing; ask me to approve", source: "provider" },
  {
    name: "compact",
    description: "Summarise the conversation to free context",
    source: "provider",
  },
  { name: "init", description: "Write an AGENTS.md for this project", source: "provider" },
  { name: "pr", description: "Open a pull request for this branch", source: "skill" },
  { name: "fork", description: "Continue in a new thread from here", source: "ace" },
];

/** Matches by prefix first, then anywhere in the name. */
export function matchCommands(list: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix = list.filter((command) => command.name.startsWith(q));
  const inner = list.filter((command) => !command.name.startsWith(q) && command.name.includes(q));
  return [...prefix, ...inner];
}

export function fakeCommandSource(): CommandSource {
  return { commands: () => Promise.resolve(commands) };
}
