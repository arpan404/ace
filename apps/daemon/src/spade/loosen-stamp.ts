import { createHash } from "node:crypto";

/*
 * Changes that may loosen what a bot may do (ADR 0171, amendment 7): moving its commands outside
 * the sandbox, widening a network policy or following a wider default, adding a grant, letting it
 * use more connected apps, turning a package's effect on. Only Spade can tell whether a change
 * loosens (it knows what holds now), so the daemon stamps each as the person's when the caller
 * proved their standing, over the bytes it forwards, and otherwise forwards it unstamped: Spade
 * then makes it only if it tightens. Pure.
 */

/** A loosening change: the bot (or `machine`) it is for, and what the stamp signs. */
export interface LooseningWrite {
  target: string;
  value: string;
  /** Forwarded unstamped when the caller hasn't proved standing; Spade decides. */
  optional: true;
}

const word = { commands: "commands", network: "network", "plugin-network": "plugin_network" };
type Kind = keyof typeof word;
const isKind = (kind: string | undefined): kind is Kind => kind !== undefined && kind in word;

function bot(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * The target and the word a loosening change's stamp starts with, from its route alone; undefined
 * for every other request.
 */
export function looseningRoute(
  method: string,
  path: string,
): { target: string; word: string; inherit: boolean } | undefined {
  const parts = (path.split("?")[0] ?? "").replace(/^\//, "").split("/");
  if (parts[0] !== "v1") return undefined;
  if (method === "PUT" && parts.length === 3 && parts[1] === "security" && isKind(parts[2]))
    return { target: "machine", word: word[parts[2]], inherit: false };
  if (parts[1] !== "agents") return undefined;
  const id = bot(parts[2]);
  if (id === undefined) return undefined;
  const rest = parts.slice(3).join("/");
  if (parts[3] === "security" && parts.length === 5 && isKind(parts[4])) {
    if (method === "PUT") return { target: id, word: word[parts[4]], inherit: false };
    if (method === "DELETE" && parts[4] !== "commands")
      return { target: id, word: word[parts[4]], inherit: true };
    return undefined;
  }
  if (method === "POST" && rest === "grants") return { target: id, word: "grant", inherit: false };
  if (method === "PUT" && rest === "connectors")
    return { target: id, word: "connectors", inherit: false };
  if (method === "PUT" && rest === "package/effects")
    return { target: id, word: "package_effect", inherit: false };
  return undefined;
}

/** The stamp's target and value for a loosening change with `body`, over its SHA-256. */
export function looseningWrite(
  method: string,
  path: string,
  body: Buffer | undefined,
): LooseningWrite | undefined {
  const route = looseningRoute(method, path);
  if (!route) return undefined;
  const value = route.inherit
    ? `${route.word}:inherit`
    : `${route.word}:${createHash("sha256")
        .update(body ?? Buffer.alloc(0))
        .digest("hex")}`;
  return { target: route.target, value, optional: true };
}
