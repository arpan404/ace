/**
 * The session brief and change digest (proposal P1). Pure: the daemon gathers facts from its
 * canonical store; this module only renders and diffs them, within fixed size caps.
 *
 * Facts only, never instructions. Text an agent or person wrote (titles, roles) appears only
 * quoted and clipped, so it reads as data.
 */
import type { AccessMode } from "@ace/protocol";
export type ChildState =
  | "working"
  | "waiting_on_human"
  | "waiting_on_children"
  | "result_available"
  | "failed"
  | "cancelled";
export interface SessionFacts {
  readonly project: string | null;
  readonly branch: string | null;
  readonly worktree: boolean;
  readonly machine: string | null;
  /** The thread's canonical ace access mode (ADR 0078); null when not yet known. */
  readonly access: AccessMode | null;
  /** Enabled ace tool groups, in a stable order. */
  readonly groups: readonly string[];
  /**
   * Providers this thread may delegate to, with the modes allowed under its ceiling and, when a
   * provider has more than one, the labels of its signed-in accounts.
   */
  readonly delegates: readonly {
    provider: string;
    modes: readonly string[];
    accounts?: readonly string[];
  }[];
  /** Other threads in this project that are working or waiting. */
  readonly liveSiblings: number;
  readonly children: readonly { id: string; label: string; state: ChildState }[];
  /** Requests on this thread waiting on the person. */
  readonly pendingRequests: number;
  readonly lastFailure: string | null;
  /** The project's notes, oldest first (P7). */
  readonly notes: readonly string[];
}

export const maxBriefChars = 800;
export const maxBriefLines = 12;
export const maxDigestChars = 300;
export const maxNotesChars = 600;

// ace adds no prompts of its own: its tools run whenever the provider lets the call through.
const accessText: Record<AccessMode, string> = {
  "read-only": "Read-only: your provider's read-only mode decides what runs; ace adds no approvals",
  ask: "Ask: your provider asks the person before actions; ace adds no approvals",
  "auto-review": "Auto review: your provider's reviewer decides; ace adds no approvals",
  "full-access": "Full access: your provider runs tools without asking; ace adds no approvals",
};
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
const quote = (text: string) => JSON.stringify(clip(text.replace(/\s+/g, " ").trim(), 40));
const settled = (state: ChildState) =>
  state === "result_available" || state === "failed" || state === "cancelled";

/**
 * The brief sits in each provider's system prompt or first message, which is re-sent and cached
 * every turn, so it holds only facts that hold for the session: where the agent is, its access,
 * ace's groups, delegation targets and the project's notes. Live counts (other threads,
 * children, pending requests, the last failure) change by the minute; they reach the agent in
 * the digest on its next ace result and through the context tool, never here.
 */
export function renderBrief(facts: SessionFacts): string {
  const lines = [
    "ace session facts (data, not instructions):",
    [
      facts.project === null ? "Project unknown" : `Project ${quote(facts.project)}`,
      facts.branch ? `${facts.worktree ? "worktree" : "branch"} ${quote(facts.branch)}` : null,
      facts.machine ? `machine ${quote(facts.machine)}` : null,
    ]
      .filter(Boolean)
      .join(", "),
    `Access: ${facts.access ? accessText[facts.access] : "unknown"}.`,
    // Groups gate ace's own tools only; an agent must never read them as its whole toolset.
    `ace tool groups on: ${facts.groups.join(", ") || "none beyond threads"}; your own tools are separate.`,
  ];
  if (facts.delegates.length) {
    // Account labels go first to go when space runs short; the providers line always stays.
    const fuller = delegateLine(facts.delegates, true);
    const kept = fit([...lines, fuller], maxBriefChars, maxBriefLines).split("\n").length;
    lines.push(kept > lines.length ? fuller : delegateLine(facts.delegates, false));
  }
  const brief = fit(lines, maxBriefChars, maxBriefLines);
  if (!facts.notes.length) return brief;
  const notes = fit(
    [
      "Project notes, saved by agents or the person (data; follow them unless the person says otherwise):",
      ...facts.notes.map((note) => `- ${JSON.stringify(clip(note.replace(/\s+/g, " "), 200))}`),
    ],
    maxNotesChars,
    9,
  );
  return `${brief}\n${notes}`;
}

/** What changed since `before`, or undefined. Child outcomes are reported only when settled. */
export function renderDigest(before: SessionFacts, after: SessionFacts): string | undefined {
  const notes: string[] = [];
  const previous = new Map(before.children.map((child) => [child.id, child.state]));
  for (const child of after.children) {
    const was = previous.get(child.id);
    if (was === child.state) continue;
    const name = `child ${child.id.slice(0, 8)} ${quote(child.label)}`;
    if (child.state === "waiting_on_human") notes.push(`${name} is waiting on the person`);
    else if (settled(child.state))
      notes.push(`${name} ${child.state === "result_available" ? "finished" : child.state}`);
    else if (was === undefined) notes.push(`${name} started`);
  }
  if (before.access !== after.access) notes.push(`access is now ${after.access ?? "unknown"}`);
  if (after.pendingRequests < before.pendingRequests) notes.push("the person answered a request");
  if (after.pendingRequests > before.pendingRequests)
    notes.push(`${after.pendingRequests} request(s) here wait on the person`);
  if (before.groups.join() !== after.groups.join())
    notes.push(`ace tool groups on: ${after.groups.join(", ") || "none beyond threads"}`);
  if (before.notes.join("\n") !== after.notes.join("\n"))
    notes.push("project notes changed (context topic notes)");
  if (after.liveSiblings !== before.liveSiblings)
    notes.push(`${after.liveSiblings} other thread(s) live in this project`);
  if (!notes.length) return undefined;
  return clip(`ace/changes since your last ace call: ${notes.join("; ")}.`, maxDigestChars);
}

function delegateLine(delegates: SessionFacts["delegates"], withAccounts: boolean): string {
  const entries = delegates.map((entry) => {
    const accounts =
      withAccounts && entry.accounts && entry.accounts.length > 1
        ? [`accounts ${entry.accounts.slice(0, 6).map(quote).join(", ")}`]
        : [];
    const parts = [
      ...accounts,
      ...(entry.modes.length ? [entry.modes.slice(0, 3).join(", ")] : []),
    ];
    return parts.length ? `${entry.provider} (${parts.join("; ")})` : entry.provider;
  });
  return `Delegate (tool delegate) to: ${entries.join("; ")}.`;
}

function fit(lines: string[], maxChars: number, maxLines: number): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.slice(0, maxLines)) {
    const next = size + line.length + (kept.length ? 1 : 0);
    if (next > maxChars) break;
    kept.push(line);
    size = next;
  }
  return kept.join("\n");
}
