import type {
  OutsideAccessDecision,
  OutsideAccessRequest,
  OutsideEndpoint,
  OutsideGrantEntry,
  OutsideProjects,
  OutsideScope,
} from "@ace/protocol";

/*
 * Words for outside MCP clients (ADR 0117): what a grant may do, how long it lasts, where a
 * client reaches this machine, and what an access request starts as. Shared by every client
 * app. Pure.
 */

const day = 86_400_000;

/** Every tick the person can change, in the order the approval shows them. Read is fixed on. */
export const outsideTicks: readonly { scope: OutsideScope; label: string }[] = [
  { scope: "threads:start", label: "Start threads" },
  { scope: "threads:message", label: "Message and steer threads" },
  { scope: "threads:stop", label: "Stop threads" },
  { scope: "browser", label: "Use the browser" },
  { scope: "computer", label: "Use the screen" },
];

const threadVerbs: readonly [OutsideScope, string][] = [
  ["threads:read", "read"],
  ["threads:start", "start"],
  ["threads:message", "message"],
  ["threads:stop", "stop"],
];

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
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

/** The projects a grant reaches: "All projects", one project's name, or "3 projects". */
export function projectsWords(projects: OutsideProjects, name: (id: string) => string): string {
  if (projects === "all") return "All projects";
  if (projects.length === 1) return name(projects[0] ?? "");
  return `${projects.length} projects`;
}

/** How long a new grant lasts. Thirty days is the default (ADR 0117). */
export type OutsideLifetime = "day" | "month" | "forever";

export const outsideLifetimes: readonly { value: OutsideLifetime; label: string }[] = [
  { value: "day", label: "A day" },
  { value: "month", label: "30 days" },
  { value: "forever", label: "Until revoked" },
];

/** When a grant chosen now with `lifetime` ends; null for until revoked. */
export function lifetimeEnd(lifetime: OutsideLifetime, now: number): number | null {
  if (lifetime === "day") return now + day;
  if (lifetime === "month") return now + 30 * day;
  return null;
}

/** Whole days, rounded up, so a grant made a moment ago for 30 days says 30. */
function daysLeft(ms: number): number {
  return Math.ceil(ms / day);
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
  const days = daysLeft(left);
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** A grant still lets its client in: not revoked and not past its end. */
export function grantIsLive(grant: OutsideGrantEntry, now: number): boolean {
  return grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now);
}

const endedAt = (grant: OutsideGrantEntry) => grant.revokedAt ?? grant.expiresAt ?? 0;

/** Live grants, most recently used first, and ended ones, most recently ended first. */
export function arrangeGrants(
  grants: readonly OutsideGrantEntry[],
  now: number,
): { live: OutsideGrantEntry[]; ended: OutsideGrantEntry[] } {
  const live = grants
    .filter((grant) => grantIsLive(grant, now))
    .toSorted(
      (a, b) =>
        (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt) || a.id.localeCompare(b.id),
    );
  const ended = grants
    .filter((grant) => !grantIsLive(grant, now))
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
export function accessRequestSentence(request: OutsideAccessRequest, machine: string): string {
  const who = clientTitle(request.clientName, request.domain);
  const wants = request.grantId ? `wants more access to ${machine}` : `wants to use ${machine}`;
  return `${who} ${wants}. Code ${request.matchCode}.`;
}

/** The screen-use line: "Claude is using this Mac", or another machine's name. */
export function screenUseSentence(names: readonly string[], machine: string): string {
  const who = names.length ? list([...new Set(names)]) : "An outside app";
  return `${who} ${names.length > 1 ? "are" : "is"} using ${machine}`;
}

/** The thread line for a thread an outside client started. */
export function startedByWords(name: string): string {
  return `Started by ${name}`;
}

/** What the person chooses on an approval, before they change anything. */
export interface OutsideChoice {
  scopes: ReadonlySet<OutsideScope>;
  projects: OutsideProjects;
  lifetime: OutsideLifetime;
}

/**
 * Where an approval starts: read only, every project, 30 days. What the client asked for is
 * shown beside each tick but never ticked for the person (ADR 0117: read is the default).
 */
export function initialChoice(): OutsideChoice {
  return { scopes: new Set(["threads:read"]), projects: "all", lifetime: "month" };
}

/** The `decide` an approval sends: read always included, scopes in a stable order. */
export function approvalDecision(choice: OutsideChoice, now: number): OutsideAccessDecision {
  const order: readonly OutsideScope[] = [
    "threads:read",
    ...outsideTicks.map((tick) => tick.scope),
  ];
  return {
    decision: "approve",
    scopes: order.filter((scope) => scope === "threads:read" || choice.scopes.has(scope)),
    projects: choice.projects,
    expiresAt: lifetimeEnd(choice.lifetime, now),
  };
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
