import { createHmac } from "node:crypto";

/*
 * The person's say on a Spade change only they may make (ADR 0163, amendment 2): turning Full
 * access on, for a bot or as the machine's default. Spade's bearer token can't tell the person
 * from a process that holds it, so the daemon forwards such a change only from a caller with the
 * person's standing and stamps it with `x-ace-person`: HMAC-SHA256, keyed with a secret only the
 * daemon and Spade read (`<ACE_HOME>/spade-person.key`, never the token), over the bot, the value,
 * the time and a single-use nonce. Spade checks it (spade-server `security::attest`). Pure.
 */

export const personHeader = "x-ace-person";

/** A change only the person may make: which bot (or `machine`, or `move:<id>`) and to what. */
export interface PersonOnlyWrite {
  target: string;
  /**
   * `full_access`, or `null`: following the parent or the machine can raise a bot too. For a
   * move, `accept:<bot>`: the person accepts that bot arriving by that move (ADR 0187).
   */
  value: string;
}

const botAutonomy = /^\/v1\/agents\/([^/?#]+)\/security\/autonomy$/;
const moveAccept = /^\/v1\/moves\/([^/?#]+)\/accept$/;
/** A move's or a bot's id, as Spade takes them: one plain name. */
const plainId = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const machineAutonomy = "/v1/security/autonomy";

/** The route a guarded change goes to, whatever its body; undefined for every other request. */
export function personOnlyRoute(method: string, path: string): string | undefined {
  if (method !== "PUT") return undefined;
  const bare = path.split("?")[0] ?? "";
  if (bare === machineAutonomy) return "machine";
  // Accepting a bot moving here: always the person's, whatever the body says.
  const move = moveAccept.exec(bare)?.[1];
  if (move !== undefined) return `move:${move}`;
  const bot = botAutonomy.exec(bare)?.[1];
  if (bot === undefined) return undefined;
  try {
    return decodeURIComponent(bot);
  } catch {
    return undefined;
  }
}

/**
 * Whether a `spade.http` request raises how a bot decides, and to what. Going back to the
 * auto-review never needs the person; any other body does, as Spade reads it (a missing value is
 * `null`), so the daemon never forwards a raise it didn't stamp as theirs.
 */
export function personOnlyWrite(
  method: string,
  path: string,
  body: Buffer | undefined,
): PersonOnlyWrite | undefined {
  const target = personOnlyRoute(method, path);
  if (target === undefined) return undefined;
  if (target.startsWith("move:")) return moveAcceptWrite(target, body);
  let value: unknown;
  try {
    value = body === undefined ? undefined : (JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
  const autonomy =
    value !== null && typeof value === "object" ? Reflect.get(value, "autonomy") : undefined;
  if (autonomy === "full_access") return { target, value: "full_access" };
  if (autonomy === null || autonomy === undefined)
    return target === "machine" ? undefined : { target, value: "null" };
  return undefined;
}

/** The stamp Spade checks: `v1.<ms>.<nonce>.<hex HMAC>`. */
export function personStamp(
  key: Uint8Array,
  write: PersonOnlyWrite,
  atMs: number,
  nonce: string,
): string {
  const mac = createHmac("sha256", key)
    .update(`ace-spade-person/1\n${write.target}\n${write.value}\n${atMs}\n${nonce}`)
    .digest("hex");
  return `v1.${atMs}.${nonce}.${mac}`;
}

/** Accepting a bot moving here: the move and the bot as Spade will check them, or nothing to
 * stamp when either isn't a plain id (Spade then refuses it unstamped). */
function moveAcceptWrite(target: string, body: Buffer | undefined): PersonOnlyWrite | undefined {
  if (!plainId.test(target.slice("move:".length))) return undefined;
  let value: unknown;
  try {
    value = body === undefined ? undefined : (JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
  const bot = value !== null && typeof value === "object" ? Reflect.get(value, "bot") : undefined;
  return typeof bot === "string" && plainId.test(bot)
    ? { target, value: `accept:${bot}` }
    : undefined;
}
