/** A file an agent changed in one thread's worktree. */
export interface FakeChangedFile {
  threadId: string;
  threadTitle: string;
  workspaceId: string;
  path: string;
  change: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  updatedAt: number;
  /** Current contents, served for a download. */
  text: string;
}

const minute = 60_000;

/** Files the workbench threads changed, newest first. */
export function changedFiles(now: number): FakeChangedFile[] {
  const file = (
    threadId: string,
    threadTitle: string,
    workspaceId: string,
    path: string,
    change: FakeChangedFile["change"],
    additions: number,
    deletions: number,
    ageMinutes: number,
    text: string,
  ): FakeChangedFile => ({
    threadId,
    threadTitle,
    workspaceId,
    path,
    change,
    additions,
    deletions,
    updatedAt: now - ageMinutes * minute,
    text,
  });
  const dedupe = ["thread-dedupe", "Dedupe thread events after reconnect", "ace"] as const;
  const retry = ["thread-retry-budget", "Retry budget for app-server restarts", "relay"] as const;
  const refund = ["thread-refund-tax", "Partial refunds double-count tax", "billing-api"] as const;
  const install = [
    "thread-install-page",
    "Rewrite the install page for the daemon",
    "docs-site",
  ] as const;
  return [
    file(
      ...dedupe,
      "packages/client/src/subscriptions.ts",
      "modified",
      48,
      12,
      3,
      "export function dedupe(events) {\n  // keeps the highest seq per event id\n}\n",
    ),
    file(
      ...dedupe,
      "packages/client/src/subscriptions.test.ts",
      "modified",
      61,
      0,
      3,
      'test("replayed events after reconnect are applied once", () => {});\n',
    ),
    file(
      ...retry,
      "src/supervisor/restart-budget.ts",
      "added",
      94,
      0,
      18,
      "export const restartBudget = { attempts: 6, windowMs: 300_000 };\n",
    ),
    file(
      ...retry,
      "src/supervisor/supervisor.ts",
      "modified",
      22,
      31,
      18,
      "// restarts back off from 250 ms to 30 s\n",
    ),
    file(
      ...refund,
      "src/refunds/tax.ts",
      "modified",
      17,
      9,
      40,
      "export function refundTax(line, ratio) {\n  return round(line.tax * ratio);\n}\n",
    ),
    file(
      ...refund,
      "src/refunds/tax.test.ts",
      "added",
      52,
      0,
      40,
      'test("a partial refund returns tax once", () => {});\n',
    ),
    file(
      ...install,
      "docs/install.md",
      "renamed",
      120,
      87,
      75,
      "# Install ace\n\nRun `ace start` and open the printed link.\n",
    ),
    file(...install, "docs/legacy-install.md", "deleted", 0, 64, 75, ""),
  ];
}
