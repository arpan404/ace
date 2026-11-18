import { z } from "zod";

/*
 * A bot moving to another of the person's machines (ADR 0187), as its profile and the CLI show
 * it: one sentence while it moves or after it failed, and one after it arrived naming what needs
 * the person. Words only; the actions are text buttons beside them.
 */

export type SpadeMoveState =
  | "packing"
  | "awaiting"
  | "sending"
  | "committing"
  | "finishing"
  | "done"
  | "failed"
  | "cancelled";

export interface SpadeMove {
  id: string;
  to: { host: string; name: string };
  state: SpadeMoveState;
  sent: number;
  total: number;
  /** The other machine can't be reached; the move tries again. */
  waiting: boolean;
  problem: string | undefined;
  /** Cancel still stops it: the commit hasn't been sent. */
  canCancel: boolean;
  /**
   * What the person accepts on the machine it goes to, once it is packed: the machine it comes
   * from, the manifest by its hash, and whether it replaces Spade there.
   */
  accept: { from: string; digest: string; replaces: "bot" | "main" } | undefined;
}

const moveShape = z.object({
  id: z.string().min(1),
  to: z.object({ host: z.string().min(1), name: z.string().catch("") }),
  state: z.enum([
    "packing",
    "awaiting",
    "sending",
    "committing",
    "finishing",
    "done",
    "failed",
    "cancelled",
  ]),
  from: z.string().nullish().catch(undefined),
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullish()
    .catch(undefined),
  replaces: z.enum(["bot", "main"]).catch("bot").default("bot"),
  sent: z.number().int().nonnegative().catch(0).default(0),
  total: z.number().int().nonnegative().catch(0).default(0),
  waiting: z.boolean().catch(false).default(false),
  problem: z.string().nullish().catch(undefined),
  can_cancel: z.boolean().catch(false).default(false),
});

export function parseSpadeMove(raw: unknown): SpadeMove | undefined {
  const parsed = moveShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const move = parsed.data;
  return {
    id: move.id,
    to: { host: move.to.host, name: move.to.name || "the other machine" },
    state: move.state,
    sent: move.sent,
    total: move.total,
    waiting: move.waiting,
    problem: move.problem ?? undefined,
    canCancel: move.can_cancel,
    accept:
      move.from && move.digest
        ? { from: move.from, digest: move.digest, replaces: move.replaces }
        : undefined,
  };
}

/** What needs the person after a bot arrived here. */
export interface SpadeArrival {
  from: string;
  at: number;
  routinesPaused: number;
  webhooks: number;
  /** The person's consent that stayed on the other machine (grants, Full access), in words. */
  consent: string[];
  endpoints: string[];
  apps: string[];
  plugins: string[];
  /** Workspace entries that stayed behind (links, special files). */
  left: string[];
}

const names = z.array(z.string()).catch([]).default([]);
const arrivalShape = z.object({
  from: z.object({ name: z.string().catch("") }).catch({ name: "" }),
  at: z.number().catch(0).default(0),
  routines_paused: z.number().int().nonnegative().catch(0).default(0),
  webhooks: z.number().int().nonnegative().catch(0).default(0),
  consent: names,
  endpoints: names,
  apps: names,
  plugins: names,
  left: names,
});

export function parseSpadeArrival(raw: unknown): SpadeArrival | undefined {
  const parsed = arrivalShape.safeParse(raw);
  if (!parsed.success || raw === null || typeof raw !== "object") return undefined;
  const arrival = parsed.data;
  return {
    from: arrival.from.name || "another machine",
    at: arrival.at,
    routinesPaused: arrival.routines_paused,
    webhooks: arrival.webhooks,
    consent: arrival.consent,
    endpoints: arrival.endpoints,
    apps: arrival.apps,
    plugins: arrival.plugins,
    left: arrival.left,
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (items: readonly string[]) =>
  items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The one sentence a move in progress, or one that failed, reads as. */
export function spadeMoveLine(move: SpadeMove, name: string): string {
  const to = move.to.name;
  switch (move.state) {
    case "packing":
      return `Getting ${name} ready to move to ${to}.`;
    case "awaiting":
      return `Waiting for your say on ${to}.`;
    case "sending":
      if (move.waiting) return `Waiting for ${to} to come online.`;
      return move.total > 0
        ? `Copying ${name} to ${to}, ${Math.min(move.sent, move.total)} of ${move.total}.`
        : `Copying ${name} to ${to}.`;
    case "committing":
      return move.waiting ? `Waiting for ${to} to finish the move.` : `Arriving on ${to}.`;
    case "finishing":
    case "done":
      return `Arriving on ${to}.`;
    case "failed":
      return `Couldn't move ${name} to ${to}${move.problem ? `: ${move.problem}` : ""}. It's still here.`;
    case "cancelled":
      return `${name} stays here.`;
  }
}

/** What an arrived bot's profile says until the person dismisses it. */
export function spadeArrivalLine(arrival: SpadeArrival): string {
  const needs: string[] = [];
  if (arrival.routinesPaused > 0)
    needs.push(
      `${count(arrival.routinesPaused, "routine is", "routines are")} paused until you resume ${arrival.routinesPaused === 1 ? "it" : "them"}`,
    );
  if (arrival.webhooks > 0)
    needs.push(`${count(arrival.webhooks, "webhook has", "webhooks have")} a new address`);
  if (arrival.consent.length > 0)
    needs.push(`give again what you allowed on ${arrival.from}: ${list(arrival.consent)}`);
  if (arrival.endpoints.length > 0)
    needs.push(
      `add ${arrival.endpoints.length === 1 ? "the endpoint" : "the endpoints"} ${list(arrival.endpoints)} on this machine`,
    );
  if (arrival.apps.length > 0) needs.push(`allow its apps again: ${list(arrival.apps)}`);
  if (arrival.plugins.length > 0) needs.push(`allow its plugins again: ${list(arrival.plugins)}`);
  if (arrival.left.length > 0)
    needs.push(`${count(arrival.left.length, "link", "links")} in its folder stayed behind`);
  const first = `Moved from ${arrival.from}.`;
  if (needs.length === 0) return first;
  const rest = needs.join("; ");
  return `${first} ${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`;
}
