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

/** A change only the person may make: which bot (or `machine`) and to what. */
export interface PersonOnlyWrite {
  target: string;
  /** `full_access`, or `null`: following the parent or the machine can raise a bot too. */
  value: "full_access" | "null";
}

const botAutonomy = /^\/v1\/agents\/([^/?#]+)\/security\/autonomy$/;
const machineAutonomy = "/v1/security/autonomy";

/** The route a guarded change goes to, whatever its body; undefined for every other request. */
export function personOnlyRoute(method: string, path: string): string | undefined {
  if (method !== "PUT") return undefined;
  const bare = path.split("?")[0] ?? "";
  if (bare === machineAutonomy) return "machine";
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
