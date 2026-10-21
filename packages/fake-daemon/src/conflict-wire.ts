import type { CommandPayload, CommandResult, GitConflictFile, GitConflicts } from "@ace/protocol";

type Step = Extract<CommandPayload, { type: "git.conflicts" }>;
const clean = (head: string): GitConflicts => ({
  head,
  merging: false,
  dirty: false,
  files: [],
  truncated: false,
});

/**
 * A PR checkout's merge conflicts (`git.conflicts`): Merge brings in the files a scenario
 * seeded, a write without markers resolves its file, and the commit ends the merge. Every
 * write is kept so a test can read what the client sent.
 */
export class FakeConflicts {
  private states = new Map<string, GitConflicts>();
  private seeded = new Map<string, readonly GitConflictFile[]>();
  /** Every `write` step's path and text, oldest first. */
  readonly written: { path: string; content: string }[] = [];
  /** The checkout of `threadId` holds the PR at `head`; merging its base conflicts in `files`. */
  seed(threadId: string, head: string, files: readonly GitConflictFile[]): void {
    this.states.set(threadId, clean(head));
    this.seeded.set(threadId, files);
  }
  read(threadId: string): GitConflicts | null {
    return this.states.get(threadId) ?? null;
  }
  command(payload: Step): Omit<CommandResult, "commandId"> {
    const state = this.states.get(payload.threadId);
    if (!state) return { ok: false, error: "git_pr_head_unavailable" };
    const step = payload.step;
    const set = (next: Partial<GitConflicts>) =>
      this.states.set(payload.threadId, { ...state, ...next });
    const drop = (path: string) => set({ files: state.files.filter((file) => file.path !== path) });
    if (step.action === "start") {
      if (state.merging) return { ok: false, error: "git_conflicts" };
      if (step.expectedHead !== state.head) return { ok: false, error: "git_head_moved" };
      const files = this.seeded.get(payload.threadId) ?? [];
      set({ merging: true, files: [...files] });
      return { ok: true, code: files.length ? "merge_conflicts" : "merge_merged" };
    }
    if (!state.merging) return { ok: false, error: "git_invalid_argument" };
    if (step.action === "abort") set(clean(state.head ?? ""));
    else if (step.action === "write") {
      this.written.push({ path: step.path, content: step.content });
      if (step.content.includes("<<<<<<<")) return { ok: true, code: "conflict_written" };
      drop(step.path);
      return { ok: true, code: "conflict_resolved" };
    } else if (step.action === "take") drop(step.path);
    else {
      if (state.files.length) return { ok: false, error: "git_conflicts" };
      const commit = "c".repeat(40);
      set({ ...clean(commit) });
      return { ok: true, commit };
    }
    return { ok: true };
  }
}
