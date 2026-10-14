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
  /** Providers this thread may delegate to, with the native modes allowed under its ceiling. */
  readonly delegates: readonly { provider: string; modes: readonly string[] }[];
  readonly titleProvisional: boolean;
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

const accessText: Record<AccessMode, string> = {
  "read-only":
    "Read-only: ace refuses navigation, screen and device actions; reads work and never prompt",
  ask: "Ask: new browser origins, app control and external effects prompt the person; reads never do",
  "auto-review":
    "Auto review: a reviewer approves routine actions and risky ones reach the person; reads never prompt",
  "full-access": "Full access: ace tools never prompt the person",
};
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
const quote = (text: string) => JSON.stringify(clip(text.replace(/\s+/g, " ").trim(), 40));
const settled = (state: ChildState) =>
  state === "result_available" || state === "failed" || state === "cancelled";

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
    `ace groups on: ${facts.groups.join(", ") || "thread only"}.`,
  ];
  if (facts.delegates.length)
    lines.push(
      `Delegate with delegate_task to: ${facts.delegates
        .map((entry) =>
          entry.modes.length
            ? `${entry.provider} (${entry.modes.slice(0, 3).join(", ")})`
            : entry.provider,
        )
        .join("; ")}.`,
    );
  if (facts.titleProvisional)
    lines.push("Title is provisional: name it with ace_thread_rename, onlyIfProvisional: true.");
  const live = facts.children.filter((child) => !settled(child.state));
  const waiting = live.filter((child) => child.state === "waiting_on_human").length;
  lines.push(
    `Live: ${facts.liveSiblings} other thread(s) in this project; ${live.length} child thread(s)${waiting ? `, ${waiting} waiting on the person` : ""}.`,
  );
  if (facts.pendingRequests)
    lines.push(`Waiting on the person here: ${facts.pendingRequests} request(s).`);
  if (facts.lastFailure) lines.push(`Last ace failure: ${clip(facts.lastFailure, 80)}.`);
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
    notes.push(`ace groups on: ${after.groups.join(", ") || "thread only"}`);
  if (before.notes.join("\n") !== after.notes.join("\n"))
    notes.push("project notes changed (ace_context topic notes)");
  if (after.liveSiblings !== before.liveSiblings)
    notes.push(`${after.liveSiblings} other thread(s) live in this project`);
  if (!notes.length) return undefined;
  return clip(`ace/changes since your last ace call: ${notes.join("; ")}.`, maxDigestChars);
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
