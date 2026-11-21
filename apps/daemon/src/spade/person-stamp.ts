import { createHmac } from "node:crypto";
import { looseningRoute, looseningWrite } from "./loosen-stamp.ts";

/*
 * The person's say on a Spade change only they may make (ADR 0163, amendment 2; ADR 0171,
 * amendment 7): turning Full access or one of a bot's Permissions on, for a bot or as the
 * machine's default, and changing the apps bots never use. Spade's bearer token can't tell the person
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
  /**
   * Only Spade can tell whether it loosens anything: stamped when the caller proved the
   * person's standing, else forwarded unstamped and Spade makes it only if it tightens.
   */
  optional?: true;
}

const botAutonomy = /^\/v1\/agents\/([^/?#]+)\/security\/autonomy$/;
const botPermissions = /^\/v1\/agents\/([^/?#]+)\/security\/permissions$/;
const machinePermissions = "/v1/security/permissions";
const neverApps = "/v1/security/never-apps";
/** A switch of the Permissions, as Spade names them. */
const switchKey = /^[a-z_]{1,32}$/;
/** What separates the never-use list's entries in the stamp: a character no entry holds. */
const listSeparator = "\u001f";
const moveAccept = /^\/v1\/moves\/([^/?#]+)\/accept$/;
/** A move's or a bot's id, as Spade takes them: one plain name. */
const plainId = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const machineAutonomy = "/v1/security/autonomy";
/** Passing Spade's host choice on to this machine (ADR 0187). */
const mainHost = "/v1/main/host";

/** The route a guarded change goes to, whatever its body; undefined for every other request. */
export function personOnlyRoute(method: string, path: string): string | undefined {
  const loosening = looseningRoute(method, path);
  if (loosening) return `loosen:${loosening.target}`;
  if (method !== "PUT") return undefined;
  const bare = path.split("?")[0] ?? "";
  if (bare === machineAutonomy) return "machine";
  if (bare === mainHost) return "main-host";
  if (bare === machinePermissions) return "permissions:machine";
  if (bare === neverApps) return "never-apps";
  const permissions = botPermissions.exec(bare)?.[1];
  if (permissions !== undefined) {
    try {
      return `permissions:${decodeURIComponent(permissions)}`;
    } catch {
      return undefined;
    }
  }
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
  const loosening = looseningWrite(method, path, body);
  if (loosening) return loosening;
  const target = personOnlyRoute(method, path);
  if (target === undefined) return undefined;
  if (target.startsWith("move:")) return moveAcceptWrite(target, body);
  if (target === "main-host") return hostWrite(target, body);
  // Only Spade can tell whether these loosen anything (ADR 0171, amendment 7).
  const optional = (write: PersonOnlyWrite | undefined) =>
    write && { ...write, optional: true as const };
  if (target === "never-apps") return optional(neverAppsWrite(body));
  if (target.startsWith("permissions:"))
    return optional(permissionWrite(target.slice("permissions:".length), body));
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

/**
 * Accepting a bot moving here (ADR 0187): the whole move as Spade will check it (the bot, the
 * machine it comes from, the device this daemon knows that machine by, the machine it goes to, the manifest by its hash, and whether it
 * replaces Spade), or nothing to stamp when any part isn't what Spade takes (it then refuses it
 * unstamped).
 */
function moveAcceptWrite(target: string, body: Buffer | undefined): PersonOnlyWrite | undefined {
  if (!plainId.test(target.slice("move:".length))) return undefined;
  let value: unknown;
  try {
    value = body === undefined ? undefined : (JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const field = (name: string) => {
    const got: unknown = Reflect.get(value, name);
    return typeof got === "string" ? got : undefined;
  };
  const [bot, from, via, to, digest, replaces] = [
    "bot",
    "from",
    "via",
    "to",
    "digest",
    "replaces",
  ].map(field);
  const plain = [bot, from, via, to].every((id) => id !== undefined && plainId.test(id));
  if (!plain || !digest || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  if (replaces !== "bot" && replaces !== "main") return undefined;
  return { target, value: `accept:${bot}:${from}:${via}:${to}:${digest}:${replaces}` };
}

/**
 * Passing Spade's host choice on (ADR 0187): the whole record as Spade checks it (the host, the
 * version, the time and who made it), or nothing to stamp when it isn't one Spade takes.
 */
function hostWrite(target: string, body: Buffer | undefined): PersonOnlyWrite | undefined {
  let value: unknown;
  try {
    value = body === undefined ? undefined : (JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const host: unknown = Reflect.get(value, "host");
  const version: unknown = Reflect.get(value, "version");
  const at: unknown = Reflect.get(value, "at");
  const by: unknown = Reflect.get(value, "by");
  if (typeof host !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(host)) return undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    return undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at)) return undefined;
  if (by !== "seed" && by !== "move") return undefined;
  return { target, value: `host:${host}:${version}:${at}:${by}` };
}

/**
 * Turning one of a bot's Permissions on, or the machine's default (ADR 0171, amendment 7): the
 * switch and its new value. Off never needs the person; following the default (`null`) can raise
 * a bot, as for Full access. Nothing to stamp for a body Spade won't take.
 */
function permissionWrite(target: string, body: Buffer | undefined): PersonOnlyWrite | undefined {
  const value = parsed(body);
  if (value === null || typeof value !== "object") return undefined;
  const key: unknown = Reflect.get(value, "key");
  const on: unknown = Reflect.get(value, "on");
  if (typeof key !== "string" || !switchKey.test(key)) return undefined;
  if (on === true) return { target, value: `permission:${key}:true` };
  if ((on === null || on === undefined) && target !== "machine")
    return { target, value: `permission:${key}:null` };
  return undefined;
}

/**
 * Changing the apps bots never use: the whole list as sent. Spade needs the stamp only when the
 * list drops an app, which the daemon can't see, so every change is the person's.
 */
function neverAppsWrite(body: Buffer | undefined): PersonOnlyWrite | undefined {
  const value = parsed(body);
  if (value === null || typeof value !== "object") return undefined;
  const apps: unknown = Reflect.get(value, "apps");
  if (!Array.isArray(apps) || !apps.every((app) => typeof app === "string")) return undefined;
  return { target: "machine", value: `never_apps:${apps.join(listSeparator)}` };
}

function parsed(body: Buffer | undefined): unknown {
  try {
    return body === undefined ? undefined : (JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
}
