/*
 * Which machine hosts Spade, the main bot (ADR 0127): one machine in the person's reach shows it.
 * Every window reaches the same answer from what it reads, so two windows never fight: the
 * oldest main bot wins, ties broken by host id; with no machine showing Spade, the machine with
 * the lowest host id among those whose Spade answers turns it back on.
 */

export interface SpadeHostSeen {
  /** The machine's stable host id. */
  host: string;
  /** When its main bot was made, while it shows one. */
  main: { createdAt: number } | undefined;
}

export interface SpadeHostPlan {
  /** The machine whose Spade is the main bot. */
  keep: string | undefined;
  /** Machines to switch their main bot off (`PUT /v1/main {"enabled": false}`). */
  disable: string[];
  /** A machine to switch it back on (`{"enabled": true}`), when none shows Spade. */
  enable: string | undefined;
}

const byHost = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function spadeHostPlan(machines: readonly SpadeHostSeen[]): SpadeHostPlan {
  const mains = machines
    .flatMap((machine) =>
      machine.main ? [{ host: machine.host, at: machine.main.createdAt }] : [],
    )
    .toSorted((a, b) => a.at - b.at || byHost(a.host, b.host));
  const keep = mains[0]?.host;
  if (keep !== undefined)
    return { keep, disable: mains.slice(1).map((main) => main.host), enable: undefined };
  const first = machines.map((machine) => machine.host).toSorted(byHost)[0];
  return { keep: first, disable: [], enable: first };
}
