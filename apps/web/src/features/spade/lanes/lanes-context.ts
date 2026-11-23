import type { SpadeAvatar, SpadeLane } from "@ace/ui-core/spade-chat";
import { createContext, use } from "react";

/*
 * What a bot's main chat knows of its task lanes (ADR 0217 §7), for the lines and rows that show
 * them: the lanes as Spade lists them, the bot's face they carry, and what opens or tries one
 * again. Absent outside a bot's main conversation, where a lane's line is only a note.
 */
export interface LanesHere {
  /** As Spade lists them, each under its current title. */
  lanes: readonly SpadeLane[];
  avatar: SpadeAvatar;
  /** A task's title as it stands now (renamed by the title role, ADR 0217 §2a), else `said`. */
  titleOf(lane: string, said: string): string;
  open(lane: string): void;
  /** Resolves false when it didn't go through (the caller said why). */
  retry(lane: string, reply: string): Promise<boolean>;
}

export const LanesContext = createContext<LanesHere | undefined>(undefined);

export const useLanesHere = () => use(LanesContext);

/** The task's title as it stands, where main's chat knows it; `said` elsewhere. */
export function useTaskTitle(
  lane: { task: string; title: string } | undefined,
): string | undefined {
  const here = useLanesHere();
  if (!lane) return undefined;
  return here ? here.titleOf(lane.task, lane.title) : lane.title;
}
