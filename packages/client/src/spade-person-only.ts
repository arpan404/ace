/*
 * Spade's routes whose changes are the person's to make (ADR 0163 amendment 2, ADR 0171
 * amendment 7, ADR 0187): the daemon stamps them as the person's when the caller proved their
 * standing, and the desktop app never sends them straight to Spade, which would get them
 * unstamped. One list for both, so a route added for one can't be missed by the other. Pure.
 */

const kinds = { commands: "commands", network: "network", "plugin-network": "plugin_network" };
type Kind = keyof typeof kinds;
const isKind = (kind: string | undefined): kind is Kind => kind !== undefined && kind in kinds;

function decoded(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * A change that may loosen what a bot may do, by its route alone: the bot (or `machine`) it is
 * for, the word its stamp starts with, and whether it follows a wider default (`inherit`).
 * Moving commands outside the sandbox, widening a network policy, adding a grant, letting a bot
 * use more connected apps, turning a package's effect on.
 */
export function spadeLooseningRoute(
  method: string,
  path: string,
): { target: string; word: string; inherit: boolean } | undefined {
  const parts = (path.split("?")[0] ?? "").replace(/^\//, "").split("/");
  if (parts[0] !== "v1") return undefined;
  if (method === "PUT" && parts.length === 3 && parts[1] === "security" && isKind(parts[2]))
    return { target: "machine", word: kinds[parts[2]], inherit: false };
  if (parts[1] !== "agents") return undefined;
  const id = decoded(parts[2]);
  if (id === undefined) return undefined;
  const rest = parts.slice(3).join("/");
  if (parts[3] === "security" && parts.length === 5 && isKind(parts[4])) {
    if (method === "PUT") return { target: id, word: kinds[parts[4]], inherit: false };
    if (method === "DELETE" && parts[4] !== "commands")
      return { target: id, word: kinds[parts[4]], inherit: true };
    return undefined;
  }
  if (method === "POST" && rest === "grants") return { target: id, word: "grant", inherit: false };
  if (method === "PUT" && rest === "connectors")
    return { target: id, word: "connectors", inherit: false };
  if (method === "PUT" && rest === "package/effects")
    return { target: id, word: "package_effect", inherit: false };
  return undefined;
}

const botAutonomy = /^\/v1\/agents\/([^/?#]+)\/security\/autonomy$/;
const botPermissions = /^\/v1\/agents\/([^/?#]+)\/security\/permissions$/;
const moveAccept = /^\/v1\/moves\/([^/?#]+)\/accept$/;

/**
 * The route a change only the person may make goes to, whatever its body: `loosen:<target>`,
 * `machine` (how bots decide), `main-host`, `permissions:<bot or machine>`, `never-apps`,
 * `move:<id>` or a bot's id (how it decides). Undefined for every other request.
 */
export function spadePersonOnlyRoute(method: string, path: string): string | undefined {
  const loosening = spadeLooseningRoute(method, path);
  if (loosening) return `loosen:${loosening.target}`;
  if (method !== "PUT") return undefined;
  const bare = path.split("?")[0] ?? "";
  if (bare === "/v1/security/autonomy") return "machine";
  if (bare === "/v1/main/host") return "main-host";
  if (bare === "/v1/security/permissions") return "permissions:machine";
  if (bare === "/v1/security/never-apps") return "never-apps";
  const permissions = botPermissions.exec(bare)?.[1];
  if (permissions !== undefined) {
    const bot = decoded(permissions);
    return bot === undefined ? undefined : `permissions:${bot}`;
  }
  const move = moveAccept.exec(bare)?.[1];
  if (move !== undefined) return `move:${move}`;
  return decoded(botAutonomy.exec(bare)?.[1]);
}
