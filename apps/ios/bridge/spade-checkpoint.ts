import type { SpadeStatus } from "@ace/protocol";
import type { SpadeAgent, SpadeGroup } from "@ace/ui-core/spade-chat";
import type { SpadeHostingWire } from "./spade-hosting.ts";
import { spadeListRows, spadePlaceLine, type SpadeListRow, type SpadeReach } from "./spade-rows.ts";

/*
 * Spade as the phone draws it at its next launch, before this runtime starts
 * (`InboxCheckpoint.swift`): whether the machine shows Spade, so the tab is there in the first
 * frame, and its bots and groups as last read. Every row is in its unconfirmed form ("Checking
 * for changes"), never working or done, until the next runtime reads them again; the runtime's
 * own state replaces it in place. Pure.
 */

/** What the runtime knows of Spade now, for its checkpoint. */
export interface SpadeKnown {
  /** Undefined until the daemon answers on this runtime. */
  status: SpadeStatus | undefined;
  /** The bots were read on this connection. */
  confirmed: boolean;
  agents: readonly SpadeAgent[] | undefined;
  groups: readonly SpadeGroup[] | undefined;
  machine: string;
  /** The machine's ace host id, for the line across machines and group faces. */
  hostId: string | undefined;
  host: string | null;
  main: SpadeHostingWire;
  sharedIn: (agent: string) => string | null;
}

/** A kept row's line, as a reconnect shows it until its list is read again (#2567). */
const unconfirmed: SpadeReach = { unconfirmed: "Checking for changes" };

/**
 * Whether what the runtime knows is worth keeping: the daemon has said whether the machine shows
 * Spade. Its bots are kept only once read on this connection; until then the tab is kept alone,
 * so a list that can't be read never leaves a tab the daemon shows hidden at the next launch.
 */
export function spadeKeepable(known: SpadeKnown): boolean {
  return known.status !== undefined;
}

/** The kept patches: the Spade tab's state as the next launch first draws it. */
export function spadeCheckpoint(known: SpadeKnown): Record<string, unknown>[] {
  const shown = known.status !== undefined && known.status.hidden !== true;
  const listed = shown && known.confirmed && (known.agents || known.groups);
  return [
    {
      type: "spade.state",
      shown,
      // Spade's own state is read again; until then the tab says it is checking.
      line: spadePlaceLine(undefined, undefined),
      host: known.host,
      main: known.main,
      list: {
        // Dimmed, as an away machine's: none of it is known to be current.
        rows: listed
          ? dimmed(
              spadeListRows(
                known.agents ?? [],
                known.groups ?? [],
                known.machine,
                { bots: unconfirmed, groups: unconfirmed },
                known.hostId,
                known.sharedIn,
              ),
            )
          : null,
        failed: false,
      },
    },
  ];
}

function dimmed(rows: SpadeListRow[]): SpadeListRow[] {
  return rows.map((row) => ({ ...row, faces: row.faces.map((face) => ({ ...face, away: true })) }));
}
