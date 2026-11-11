import type {
  OutsideAccessRequest,
  OutsideProjects,
  OutsideScope,
  StartedByClient,
} from "@ace/protocol";

/*
 * MCP clients outside ace (ADR 0117) in words: what a grant lets a client do, which projects,
 * how long, the sign-in choices the person makes, and the lines that name a client elsewhere
 * ("Started by Claude", "Claude is using this Mac"). Pure; every client app draws these.
 */

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

/** The scopes in display order, `threads:read` always among them. */
export function orderedScopes(scopes: readonly OutsideScope[]): OutsideScope[] {
  const held = new Set<OutsideScope>([...scopes, "threads:read"]);
  return outsideScopeOrder.filter((scope) => held.has(scope));
}

const verbs = { "threads:start": "start", "threads:message": "message", "threads:stop": "stop" };
const tools = { browser: "the browser", computer: "the screen" };

function list(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * What a grant may do, as one sentence: "Can read threads", "Can read, start and stop threads",
 * "Can read and message threads, and use the browser and the screen".
 */
export function outsideAccessSentence(scopes: readonly OutsideScope[]): string {
  const held = new Set(scopes);
  const thread = (["threads:start", "threads:message", "threads:stop"] as const).filter((scope) =>
    held.has(scope),
  );
  const used = (["browser", "computer"] as const).filter((scope) => held.has(scope));
  const threads = `Can ${list(["read", ...thread.map((scope) => verbs[scope])])} threads`;
  if (!used.length) return threads;
  return `${threads}, and use ${list(used.map((scope) => tools[scope]))}`;
}

/**
 * The projects a grant covers: "All projects", one or two by name, else a count. A project the
 * client doesn't know by name shows its id.
 */
export function outsideProjectsLine(
  projects: OutsideProjects | readonly string[],
  name: (workspaceId: string) => string | undefined,
): string {
  if (projects === "all") return "All projects";
  const names = projects.map((id) => name(id) ?? id);
  if (names.length <= 2) return list(names);
  return `${names.length} projects`;
}

/** How long an approval lasts: a day, 30 days (the default) or until revoked. */
export const outsideExpiryChoices = [
  { id: "day", label: "A day", ms: 24 * 60 * 60_000 },
  { id: "month", label: "30 days", ms: 30 * 24 * 60 * 60_000 },
  { id: "never", label: "Until revoked", ms: null },
] as const;
export type OutsideExpiryChoice = (typeof outsideExpiryChoices)[number]["id"];
export const defaultOutsideExpiry: OutsideExpiryChoice = "month";

/**
 * When the chosen expiry ends, from `now`, in whole milliseconds as the protocol counts them
 * (a phone's clock has fractions); null: until revoked.
 */
export function outsideExpiresAt(choice: OutsideExpiryChoice, now: number): number | null {
  const found = outsideExpiryChoices.find((entry) => entry.id === choice);
  return found?.ms == null ? null : Math.floor(now) + found.ms;
}

/** Where a grant stands now. */
export type OutsideGrantState = "active" | "expired" | "revoked";
export function outsideGrantState(
  grant: { expiresAt: number | null; revokedAt: number | null },
  now: number,
): OutsideGrantState {
  if (grant.revokedAt !== null) return "revoked";
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "expired";
  return "active";
}

/** The client's domain, or that nothing vouches for it. */
export function outsideClientDomain(domain: string | null): string {
  return domain ?? "Unverified";
}

/**
 * One tick on the sign-in sheet: on or off to begin with, fixed when it can't change, and
 * whether the client asked for it.
 */
export interface OutsideScopeChoice {
  scope: OutsideScope;
  label: string;
  note: string;
  on: boolean;
  fixed: boolean;
  asked: boolean;
}

/**
 * The sign-in sheet's ticks for a request: read fixed on, everything else off until the person
 * turns it on, the ones the client asked for marked. A step-up for a grant already holding some
 * starts from what the grant holds.
 */
export function outsideScopeChoices(
  request: Pick<OutsideAccessRequest, "scopes">,
  held: readonly OutsideScope[] = [],
): OutsideScopeChoice[] {
  const asked = new Set(request.scopes);
  const on = new Set(held);
  return outsideScopeOrder.map((scope) => ({
    scope,
    label: outsideScopeLabels[scope],
    note: outsideScopeNotes[scope],
    on: scope === "threads:read" || on.has(scope),
    fixed: scope === "threads:read",
    asked: asked.has(scope),
  }));
}

/** The line a thread an outside client started carries: "Started by Claude". */
export function startedByClientLine(client: Pick<StartedByClient, "name">): string {
  return `Started by ${client.name.trim() || "an outside app"}`;
}

/**
 * The one line while outside clients use this machine's screen: "Claude is using this Mac",
 * "Claude and ChatGPT are using this computer".
 */
export function outsideScreenLine(names: readonly string[], mac: boolean): string | undefined {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (!unique.length) return undefined;
  const place = mac ? "this Mac" : "this computer";
  return `${list(unique)} ${unique.length === 1 ? "is" : "are"} using ${place}`;
}
