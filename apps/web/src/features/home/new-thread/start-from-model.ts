import type { ForgeIssueRow, ForgePrRow } from "@ace/protocol";

/** One piece of open work a new thread can start from. */
export interface StartRow {
  url: string;
  number: number;
  title: string;
  /** What needs the person about it, if anything. */
  note?: { text: string; failed: boolean } | undefined;
  updatedAt: number | undefined;
}

/** How many rows each list shows: a starting point, not a browser. */
export const startRowLimit = 5;

function time(text: string): number | undefined {
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

function prNote(row: ForgePrRow): StartRow["note"] {
  if (row.ci === "failure") return { text: "Checks failing", failed: true };
  if (row.state === "draft") return { text: "Draft", failed: false };
  if (row.ci === "pending") return { text: "Checks running", failed: false };
  return undefined;
}

/**
 * Open pull requests with failing checks first, since they need fixing; otherwise in the
 * daemon's order (newest activity first).
 */
export function pullRequestRows(rows: readonly ForgePrRow[]): StartRow[] {
  const failing = rows.filter((row) => row.ci === "failure");
  const rest = rows.filter((row) => row.ci !== "failure");
  return [...failing, ...rest].slice(0, startRowLimit).map((row) => ({
    url: row.url,
    number: row.ref.number,
    title: row.title,
    note: prNote(row),
    updatedAt: time(row.updatedAt),
  }));
}

/** Open issues in the daemon's order (newest activity first), each with its first label. */
export function issueRows(rows: readonly ForgeIssueRow[]): StartRow[] {
  return rows.slice(0, startRowLimit).map((row) => ({
    url: row.url,
    number: row.ref.number,
    title: row.title,
    note: row.labels[0] ? { text: row.labels[0], failed: false } : undefined,
    updatedAt: time(row.updatedAt),
  }));
}
