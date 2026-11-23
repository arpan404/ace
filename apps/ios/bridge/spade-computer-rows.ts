import { coworkState } from "@ace/ui-core/cowork";
import {
  spadeSurfaceLine,
  spadeUsedSurfaces,
  type SpadeAgentState,
  type SpadeComputer,
  type SpadeSurfaceKind,
} from "@ace/ui-core/spade-chat";

/*
 * A bot's computer as the iPhone draws it (web's `use-bot-computer.ts` and `drive-line.tsx`):
 * who has it, whether the person's input may go in, and the one line under each surface with
 * Take over or Hand back. Pure: the computer as Spade last said, and whether the bot is at work.
 */

export type SpadeDriveAction = "take-over" | "hand-back";

/** The line under a surface: one sentence, the bot's face while it drives, and its button. */
export interface SpadeDriveLine {
  sentence: string;
  /** The bot drives now: its face moves beside the sentence. */
  face: boolean;
  /** Null while neither uses it: one quiet sentence, no button. */
  action: SpadeDriveAction | null;
}

export interface SpadeComputerSurfaceRow {
  kind: SpadeSurfaceKind;
  /** The bot uses it now: Spade keeps it live and the bot is at work. */
  live: boolean;
  line: string | null;
  url: string | null;
  tabId: string | null;
  /** `user`: a tab in the person's own Chrome, which ace doesn't stream. */
  ownChrome: boolean;
  endingStuck: boolean;
}

export interface SpadeComputerRow {
  /**
   * The person's input goes in on this word of Spade's: in cowork with no take-over, or in
   * exclusive mode while they drive and the bot's work has stopped. The phone also holds it off
   * while a read is stale or a change of hands is on its way.
   */
  mayAct: boolean;
  /** Exclusive mode is the person's: they drive and the bot is paused. */
  driving: boolean;
  /** The hidden ace thread the bot's browser and screen run in, once it used either. */
  threadId: string | null;
  /** The bot reached for its browser or screen and it hasn't shown yet: "Waking up…". */
  waking: boolean;
  /** What the bot has ever used, in the switcher's order; terminal and files always. */
  used: SpadeSurfaceKind[];
  surfaces: SpadeComputerSurfaceRow[];
  /** The line under each surface. Files speaks of "the computer". */
  drive: Record<SpadeSurfaceKind, SpadeDriveLine>;
}

/** What each surface is called in its line ("is using the browser"). */
const what: Record<SpadeSurfaceKind, string> = {
  browser: "browser",
  screen: "screen",
  terminal: "terminal",
  files: "computer",
};

/** A reply, a tool or a job runs, or the bot waits on the person mid-work. */
export const spadeAtWork = (state: SpadeAgentState | undefined) =>
  state === "working" || state === "waiting";

export function spadeComputerRow(
  computer: SpadeComputer,
  name: string,
  atWork: boolean,
): SpadeComputerRow {
  const person = computer.driver === "person";
  const cowork = computer.mode === "cowork";
  const fresh = !computer.stopping;
  const driving = fresh && person;
  const agentActive = atWork && computer.surfaces.some((each) => each.live);
  const yielding = computer.surfaces.some((each) => each.live && each.personActive);
  const status = coworkState({ exclusive: person, personActive: cowork && yielding, agentActive });
  const stopping = person && computer.stopping;
  const line = (kind: SpadeSurfaceKind): SpadeDriveLine => {
    const words = what[kind];
    if (stopping) return { sentence: `Stopping ${name}…`, face: false, action: "hand-back" };
    if (person) return { sentence: `You have the ${words}`, face: false, action: "hand-back" };
    if (status === "waiting")
      return { sentence: `${name} is waiting for you`, face: true, action: "take-over" };
    if (status === "working")
      return { sentence: `${name} is using the ${words}`, face: true, action: "take-over" };
    return { sentence: `${name} isn't using the ${words} now.`, face: false, action: null };
  };
  const used = spadeUsedSurfaces(computer);
  for (const always of ["terminal", "files"] as const)
    if (!used.includes(always)) used.push(always);
  const order: SpadeSurfaceKind[] = ["browser", "screen", "terminal", "files"];
  return {
    mayAct: driving || (fresh && cowork && !person),
    driving,
    threadId: computer.threadId ?? null,
    waking: computer.state === "starting",
    used: order.filter((kind) => used.includes(kind)),
    surfaces: computer.surfaces.map((surface) => ({
      kind: surface.kind,
      live: atWork && surface.live,
      line: spadeSurfaceLine(surface) ?? null,
      url: surface.url ?? null,
      tabId: surface.tabId ?? null,
      ownChrome: surface.backend === "user",
      endingStuck: surface.endingStuck,
    })),
    drive: {
      browser: line("browser"),
      screen: line("screen"),
      terminal: line("terminal"),
      files: line("files"),
    },
  };
}
