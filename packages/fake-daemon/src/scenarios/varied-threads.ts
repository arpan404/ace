import type { CardSeed } from "./card-details.ts";

/*
 * Varied threads for the long lists (`?fakeLists=`): each one a real-looking task on one of the
 * seeded projects, run by one of the providers, with its own branch and, now and then, a pull
 * request, a worktree, another machine and a diff, so a long Snoozed or Settled list reads like
 * a person's own rather than one row repeated. Pure: thread `n` is always the same thread.
 */

const providers = ["claude", "codex", "cursor", "opencode", "claude", "codex"] as const;
const projects = ["ace", "relay", "billing-api", "ace-mobile", "docs-site", "acme"] as const;
const tasks = [
  ["fix", "Retry the replay after a dropped socket"],
  ["feat", "Add a dark theme to the settings page"],
  ["docs", "Document the relay's rate limits"],
  ["fix", "Round VAT per line, not per invoice"],
  ["perf", "Batch thread updates in the sidebar"],
  ["chore", "Bump the Codex app-server to 0.49"],
  ["test", "Cover the refund path with fixtures"],
  ["feat", "Push approvals to the phone"],
  ["fix", "Keep the composer draft across reloads"],
  ["refactor", "Split the forge client by resource"],
  ["docs", "Write the install guide for Linux"],
  ["fix", "Stop the PDF export losing its locale"],
  ["feat", "Show a diff summary on each row"],
  ["perf", "Cache the model catalog per account"],
  ["fix", "Recover a stale worktree lock"],
  ["test", "Fuzz the wire decoder with old frames"],
] as const;

export type VariedProvider = (typeof providers)[number];

export interface VariedThread {
  title: string;
  provider: VariedProvider;
  workspaceId: string;
  seed: CardSeed;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");

/** Thread `n` (from 0) of a long list. */
export function variedThread(n: number): VariedThread {
  const [kind, title] = tasks[n % tasks.length] ?? tasks[0];
  const provider = providers[n % providers.length] ?? "claude";
  // Projects step at a different pace from tasks, so the same task meets different projects.
  const workspaceId = projects[Math.floor(n / 2) % projects.length] ?? "ace";
  const seed: CardSeed = {
    branch: `${kind}/${slug(title)}-${n + 1}`,
    ...(n % 3 === 0 ? { pr: 300 + n } : {}),
    ...(n % 4 === 1 ? { worktree: true } : {}),
    ...(n % 7 === 3 ? { remote: true } : {}),
    ...(n % 2 === 0 ? { diff: [((n * 13) % 180) + 4, (n * 7) % 60, (n % 6) + 1] } : {}),
  };
  return { title, provider, workspaceId, seed };
}
