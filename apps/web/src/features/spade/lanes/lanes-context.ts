import type { SpadeAvatar, SpadeLane } from "@ace/ui-core/spade-chat";
import { createContext, use } from "react";

/*
 * What a bot's main chat knows of its task lanes (ADR 0217 §7), for the lines and rows that show
 * them: the lanes as Spade lists them, the bot's face they carry, and what opens or tries one
 * again. Absent outside a bot's main conversation, where a lane's line is only a note.
 */
export interface LanesHere {
  lanes: readonly SpadeLane[];
  avatar: SpadeAvatar;
  open(lane: string): void;
  /** Resolves false when it didn't go through (the caller said why). */
  retry(lane: string, reply: string): Promise<boolean>;
}

export const LanesContext = createContext<LanesHere | undefined>(undefined);

export const useLanesHere = () => use(LanesContext);
