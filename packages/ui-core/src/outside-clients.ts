import type {
  OutsideAccessDecision,
  OutsideAccessRequest,
  OutsideEndpoint,
  OutsideGrantEntry,
  OutsideProjects,
  OutsideScope,
} from "@ace/protocol";

/*
 * Words for outside MCP clients (ADR 0122): what a grant may do, which projects, how long it
 * lasts, where a client reaches this machine, the sign-in choices the person makes, and the
 * lines that name a client elsewhere ("Started by Claude", "Claude is using this Mac"). Shared
 * by every client app: desktop, web and the iPhone bridge. Pure.
 */

const day = 86_400_000;

/** Every scope in the order the person sees them; `threads:read` first and always on. */
export const outsideScopeOrder: readonly OutsideScope[] = [
  "threads:read",
  "threads:start",
  "threads:message",
  "threads:stop",
  "browser",
  "computer",
];

/** Each scope as its tick reads. */
export const outsideScopeLabels: Record<OutsideScope, string> = {
  "threads:read": "Read threads",
  "threads:start": "Start threads",
  "threads:message": "Message and steer threads",
  "threads:stop": "Stop threads",
  browser: "Use the browser",
  computer: "Use the screen",
};

/** What each scope allows, said under its tick. */
export const outsideScopeNotes: Record<OutsideScope, string> = {
  "threads:read": "Projects, models, threads and what agents said. Always included.",
  "threads:start": "Start new threads in the projects you allow.",
  "threads:message": "Send and steer messages in threads it can read.",
  "threads:stop": "Stop a thread's work.",
  browser: "Open and drive pages in its own browser tabs.",
  computer: "Use apps on this computer's screen, as agents in ace do.",
};

/** Every tick the person can change, in display order. Read is fixed on, so it isn't one. */
export const outsideTicks: readonly { scope: OutsideScope; label: string; note: string }[] =
  outsideScopeOrder
    .filter((scope) => scope !== "threads:read")
    .map((scope) => ({ scope, label: outsideScopeLabels[scope], note: outsideScopeNotes[scope] }));

/** The scopes in display order, `threads:read` always among them. */
export function orderedScopes(scopes: Iterable<OutsideScope>): OutsideScope[] {
  const held = new Set<OutsideScope>([...scopes, "threads:read"]);
  return outsideScopeOrder.filter((scope) => held.has(scope));
}

const threadVerbs: readonly [OutsideScope, string][] = [
  ["threads:read", "read"],
  ["threads:start", "start"],
  ["threads:message", "message"],
  ["threads:stop", "stop"],
];

function list(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * What a grant may do, in one sentence: "Read, start and message threads", "Read threads and
 * use the browser". Read is always part of a grant, so it is always said.
 */
export function scopeWords(scopes: readonly OutsideScope[]): string {
  const has = new Set<OutsideScope>([...scopes, "threads:read"]);
  const verbs = threadVerbs.filter(([scope]) => has.has(scope)).map(([, verb]) => verb);
  const threads = `${list(verbs)} threads`;
  const tools = [
    has.has("browser") ? "use the browser" : undefined,
    has.has("computer") ? "use the screen" : undefined,
  ].filter((word): word is string => word !== undefined);
  const sentence = list([threads, ...tools]);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The projects a grant reaches: "All projects", one or two by name, else a count. A project
 * the client doesn't know by name shows its id.
 */
export function projectsWords(
  projects: OutsideProjects | readonly string[],
  name: (id: string) => string | undefined,
): string {
  if (projects === "all") return "All projects";
  const names = projects.map((id) => name(id) ?? id);
  if (names.length <= 2) return list(names);
  return `${names.length} projects`;
}

/** How long a new grant lasts. Thirty days is the default (ADR 0122). */
export type OutsideLifetime = "day" | "month" | "forever";

export const outsideLifetimes: readonly { value: OutsideLifetime; label: string }[] = [
  { value: "day", label: "A day" },
  { value: "month", label: "30 days" },
  { value: "forever", label: "Until revoked" },
];

export const defaultLifetime: OutsideLifetime = "month";

/**
 * When a grant chosen now with `lifetime` ends, in whole milliseconds as the protocol counts
 * them (a phone's clock has fractions); null for until revoked.
 */
export function lifetimeEnd(lifetime: OutsideLifetime, now: number): number | null {
  if (lifetime === "day") return Math.floor(now) + day;
  if (lifetime === "month") return Math.floor(now) + 30 * day;
  return null;
}

/** When a grant ends, for its row: "Until revoked", "Expires in 3 hours", "Expires in 30 days". */
export function expiryWords(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "Until revoked";
  const left = expiresAt - now;
  if (left <= 0) return "Expired";
  if (left < 3_600_000) {
    const minutes = Math.max(1, Math.ceil(left / 60_000));
    return `Expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (left < day) {
    const hours = Math.ceil(left / 3_600_000);
    return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  // Whole days, rounded up, so a grant made a moment ago for 30 days says 30.
  const days = Math.ceil(left / day);
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** Where a grant stands now. */
export type OutsideGrantState = "active" | "expired" | "revoked";

export function grantState(
  grant: Pick<OutsideGrantEntry, "expiresAt" | "revokedAt">,
  now: number,
): OutsideGrantState {
  if (grant.revokedAt !== null) return "revoked";
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "expired";
  return "active";
}

const endedAt = (grant: OutsideGrantEntry) => grant.revokedAt ?? grant.expiresAt ?? 0;

/** Live grants, most recently used first, and ended ones, most recently ended first. */
export function arrangeGrants(
  grants: readonly OutsideGrantEntry[],
  now: number,
): { live: OutsideGrantEntry[]; ended: OutsideGrantEntry[] } {
  const live = grants
    .filter((grant) => grantState(grant, now) === "active")
    .toSorted(
      (a, b) =>
        (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt) || a.id.localeCompare(b.id),
    );
  const ended = grants
    .filter((grant) => grantState(grant, now) !== "active")
    .toSorted((a, b) => endedAt(b) - endedAt(a) || a.id.localeCompare(b.id));
  return { live, ended };
}

/** How an ended grant ended: "Revoked" or "Expired". */
export function endedWords(grant: OutsideGrantEntry): string {
  return grant.revokedAt !== null ? "Revoked" : "Expired";
}

/** Who the client is: its verified domain, or "unverified". */
export function clientDomainWords(domain: string | null): string {
  return domain ?? "unverified";
}

/** "Claude (claude.ai)" for a verified client; its bare name when unverified. */
export function clientTitle(name: string, domain: string | null): string {
  return domain ? `${name} (${domain})` : name;
}

/** The notice for a pending request: "Claude (claude.ai) wants to use Studio. Code 4F7K." */
export function accessRequestSentence(
  request: Pick<OutsideAccessRequest, "clientName" | "domain" | "matchCode">,
  machine: string,
): string {
  return `${clientTitle(request.clientName, request.domain)} wants to use ${machine}. Code ${request.matchCode}.`;
}

/**
 * Where the sign-in's code goes once approved, for the approver to check: "Signs in to
 * claude.ai" for a website. For a loopback address or an app's own scheme nothing vouches for
 * the app, so it warns instead. Undefined when the daemon didn't say.
 */
export function redirectWords(
  request: Pick<OutsideAccessRequest, "redirectHost" | "redirectKind">,
): string | undefined {
  if (request.redirectKind === "this-device")
    return "The code goes to an app on the device where the sign-in started. Approve only if you started it.";
  if (request.redirectKind === "web" && request.redirectHost)
    return `Signs in to ${request.redirectHost}`;
  return undefined;
}

/** "this Mac" or "this computer", for the machine the person is looking at. */
export function thisMachineWords(mac: boolean): string {
  return mac ? "this Mac" : "this computer";
}

/**
 * The screen-use line: "Claude is using this Mac", "Claude and ChatGPT are using Studio".
 * `machine` is "this Mac", "this computer" or another machine's name.
 */
export function screenUseSentence(names: readonly string[], machine: string): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const who = unique.length ? list(unique) : "An outside app";
  return `${who} ${unique.length > 1 ? "are" : "is"} using ${machine}`;
}

/** The thread line for a thread an outside client started: "Started by Claude". */
export function startedByWords(name: string): string {
  return `Started by ${name.trim() || "an outside app"}`;
}

/** What the person chooses on an approval, before they change anything. */
export interface OutsideChoice {
  scopes: ReadonlySet<OutsideScope>;
  projects: OutsideProjects;
  lifetime: OutsideLifetime;
}

/**
 * Where an approval starts: read only, every project, 30 days. What the client asked for is
 * shown beside each tick but never ticked for the person (ADR 0122: read is the default).
 */
export function initialChoice(): OutsideChoice {
  return { scopes: new Set(["threads:read"]), projects: "all", lifetime: defaultLifetime };
}

/** The `decide` an approval sends: read always included, scopes in a stable order. */
export function approvalDecision(choice: OutsideChoice, now: number): OutsideAccessDecision {
  return {
    decision: "approve",
    scopes: orderedScopes(choice.scopes),
    projects: choice.projects,
    expiresAt: lifetimeEnd(choice.lifetime, now),
  };
}

/** One tick as a list draws it: on to begin with, fixed when it can't change, asked for. */
export interface OutsideScopeChoice {
  scope: OutsideScope;
  label: string;
  note: string;
  on: boolean;
  fixed: boolean;
  asked: boolean;
}

/**
 * Every tick with its starting state: read fixed on, the rest on only if `held` has them
 * (editing a grant) and off otherwise (a sign-in), with what the client `asked` for marked.
 */
export function scopeChoices(
  asked: readonly OutsideScope[],
  held: readonly OutsideScope[] = [],
): OutsideScopeChoice[] {
  const wants = new Set(asked);
  const on = new Set(held);
  return outsideScopeOrder.map((scope) => ({
    scope,
    label: outsideScopeLabels[scope],
    note: outsideScopeNotes[scope],
    on: scope === "threads:read" || on.has(scope),
    fixed: scope === "threads:read",
    asked: wants.has(scope),
  }));
}

/** The four ways in, named for the person. */
export const endpointNames: Record<OutsideEndpoint["path"], string> = {
  local: "This computer",
  tailscale: "Tailscale",
  relay: "ace's relay",
  custom: "Your own URL",
};

/** The command a terminal agent's person runs to get a pasted token. */
export const enrollCommand = "ace mcp enroll";
