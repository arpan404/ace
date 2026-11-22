import type {
  CommandPayload,
  CommandResult,
  GitStatusFile,
  GitStatusSectionEntry,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";

export interface FakeSourceControlSeed {
  branch?: string | undefined;
  staged?: readonly GitStatusSectionEntry[] | undefined;
  unstaged?: readonly GitStatusSectionEntry[] | undefined;
  untracked?: readonly GitStatusSectionEntry[] | undefined;
  conflicted?: readonly GitStatusSectionEntry[] | undefined;
  upstream?: string | null | undefined;
  ahead?: number | undefined;
  behind?: number | undefined;
  detached?: boolean | undefined;
  /** `git.fetch` fails with this code. */
  fetchError?: string | undefined;
  /** What a failed fetch still learned from the remotes it reached: this many behind. */
  fetchErrorBehind?: number | undefined;
}

interface ThreadSourceControl {
  staged: GitStatusSectionEntry[];
  unstaged: GitStatusSectionEntry[];
  untracked: GitStatusSectionEntry[];
  conflicted: GitStatusSectionEntry[];
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  fetchError?: string | undefined;
  fetchErrorBehind?: number | undefined;
  commits: {
    message: string;
    stagedOnly: boolean;
    paths: string[];
    stageListed: string[];
    head: string;
  }[];
}

function byPath<T extends { path: string }>(entries: readonly T[]): T[] {
  return [...entries].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function statusFromFiles(files: readonly GitStatusFile[]): {
  unstaged: GitStatusSectionEntry[];
  untracked: GitStatusSectionEntry[];
} {
  const unstaged: GitStatusSectionEntry[] = [];
  const untracked: GitStatusSectionEntry[] = [];
  for (const file of files) {
    const entry: GitStatusSectionEntry = {
      path: file.path,
      ...(file.from ? { from: file.from } : {}),
      status: file.status,
    };
    if (file.status === "untracked") untracked.push(entry);
    else unstaged.push(entry);
  }
  return { unstaged: byPath(unstaged), untracked: byPath(untracked) };
}

function flatFilesOf(state: ThreadSourceControl): GitStatusFile[] {
  const map = new Map<string, GitStatusFile>();
  for (const entry of [
    ...state.conflicted,
    ...state.staged,
    ...state.unstaged,
    ...state.untracked,
  ]) {
    if (map.has(entry.path)) continue;
    map.set(entry.path, {
      path: entry.path,
      ...(entry.from ? { from: entry.from } : {}),
      status: entry.status === "conflicted" ? "modified" : entry.status,
      additions: 1,
      deletions: entry.status === "deleted" ? 1 : 0,
      binary: false,
    });
  }
  return byPath([...map.values()]);
}

/**
 * Source control for fake threads: `git.status` sections, staging, fetch and commits,
 * answered as the daemon would.
 */
export class FakeSourceControlWire {
  private states = new Map<string, ThreadSourceControl>();
  private commitSeq = 0;
  private context: FakeServiceContext;

  constructor(context: FakeServiceContext) {
    this.context = context;
  }

  private ensure(threadId: string, fallbackFiles: readonly GitStatusFile[]): ThreadSourceControl {
    let state = this.states.get(threadId);
    if (!state) {
      const thread = this.context.thread(threadId)?.thread;
      const derived = statusFromFiles(fallbackFiles);
      const branch = thread?.details?.branch ?? "main";
      state = {
        staged: [],
        unstaged: derived.unstaged,
        untracked: derived.untracked,
        conflicted: [],
        upstream: `origin/${branch}`,
        ahead: thread?.details?.ahead ?? 0,
        behind: thread?.details?.behind ?? 0,
        detached: false,
        commits: [],
      };
      this.states.set(threadId, state);
    }
    return state;
  }

  seed(threadId: string, seed: FakeSourceControlSeed): void {
    const state = this.ensure(threadId, []);
    if (seed.branch !== undefined) {
      const existing = this.context.thread(threadId)?.thread.details;
      this.context.update(threadId, {
        type: "thread.client.updated",
        changes: { details: { ...existing, branch: seed.branch } },
      });
    }
    if (seed.staged !== undefined) state.staged = byPath(seed.staged);
    if (seed.unstaged !== undefined) state.unstaged = byPath(seed.unstaged);
    if (seed.untracked !== undefined) state.untracked = byPath(seed.untracked);
    if (seed.conflicted !== undefined) state.conflicted = byPath(seed.conflicted);
    if (seed.upstream !== undefined) state.upstream = seed.upstream;
    if (seed.ahead !== undefined) state.ahead = seed.ahead;
    if (seed.behind !== undefined) state.behind = seed.behind;
    if (seed.detached !== undefined) state.detached = seed.detached;
    if (seed.fetchError !== undefined) state.fetchError = seed.fetchError;
    if (seed.fetchErrorBehind !== undefined) state.fetchErrorBehind = seed.fetchErrorBehind;
    this.syncDetails(threadId, state);
  }

  /**
   * Change the checkout without telling anyone, as an agent or a terminal would between a
   * status read and the person's click: stage `staged`, or leave `unstaged` as a new change.
   */
  changeUnseen(
    threadId: string,
    change: { staged?: GitStatusSectionEntry; unstaged?: GitStatusSectionEntry },
  ): void {
    const state = this.ensure(threadId, []);
    if (change.staged) state.staged = byPath([...state.staged, change.staged]);
    if (change.unstaged) state.unstaged = byPath([...state.unstaged, change.unstaged]);
  }

  commits(threadId: string): readonly ThreadSourceControl["commits"][number][] {
    return this.states.get(threadId)?.commits ?? [];
  }

  markPushed(threadId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    state.ahead = 0;
  }

  statusFields(threadId: string, fallbackFiles: readonly GitStatusFile[]) {
    const state = this.states.get(threadId);
    const thread = this.context.thread(threadId)?.thread;
    const branch = thread?.details?.branch ?? "main";
    if (!state) {
      const derived = statusFromFiles(fallbackFiles);
      return {
        staged: [] as GitStatusSectionEntry[],
        unstaged: derived.unstaged,
        untracked: derived.untracked,
        conflicted: [] as GitStatusSectionEntry[],
        branch,
        detached: false,
        upstream: branch ? `origin/${branch}` : null,
        ahead: thread?.details?.ahead ?? 0,
        behind: thread?.details?.behind ?? 0,
      };
    }
    return {
      staged: state.staged,
      unstaged: state.unstaged,
      untracked: state.untracked,
      conflicted: state.conflicted,
      branch: state.detached ? null : branch,
      detached: state.detached,
      upstream: state.upstream,
      ahead: state.ahead,
      behind: state.behind,
    };
  }

  hasState(threadId: string): boolean {
    return this.states.has(threadId);
  }

  flatFiles(threadId: string): GitStatusFile[] {
    const state = this.states.get(threadId);
    return state ? flatFilesOf(state) : [];
  }

  commit(
    threadId: string,
    payload: Extract<CommandPayload, { type: "git.commit" }>,
    fallbackFiles: readonly GitStatusFile[],
  ): Omit<CommandResult, "commandId"> | undefined {
    if (!this.states.has(threadId) && !payload.stagedOnly) return undefined;
    const thread = this.context.thread(threadId)?.thread;
    if ((thread?.details?.head ?? null) !== payload.expectedHead) {
      return { ok: false, error: "git_head_moved" };
    }
    const state = this.ensure(threadId, fallbackFiles);
    if (state.conflicted.length > 0) return { ok: false, error: "git_conflicts" };
    if (payload.stageListed) {
      // Like the daemon: refuse if anything was staged since the view read the status, else
      // stage exactly the listed paths and commit the index.
      if (state.staged.length > 0) return { ok: false, error: "git_staged_meanwhile" };
      const listed = new Set(payload.stageListed);
      state.unstaged = state.unstaged.filter((entry) => !listed.has(entry.path));
      state.untracked = state.untracked.filter((entry) => !listed.has(entry.path));
    } else if (payload.stagedOnly && !payload.paths) {
      if (state.staged.length === 0) {
        return { ok: false, error: "git_nothing_to_commit" };
      }
      state.staged = [];
    } else if (payload.paths) {
      const named = new Set(payload.paths);
      state.staged = state.staged.filter((entry) => !named.has(entry.path));
      state.unstaged = state.unstaged.filter((entry) => !named.has(entry.path));
      state.untracked = state.untracked.filter((entry) => !named.has(entry.path));
    } else {
      if (
        state.staged.length === 0 &&
        state.unstaged.length === 0 &&
        state.untracked.length === 0
      ) {
        return { ok: false, error: "git_nothing_to_commit" };
      }
      state.staged = [];
      state.unstaged = [];
      state.untracked = [];
    }
    const hex = (++this.commitSeq).toString(16).padStart(40, "a");
    state.ahead += 1;
    state.commits.push({
      message: payload.message,
      stagedOnly: Boolean(payload.stagedOnly),
      paths: [...(payload.paths ?? [])],
      stageListed: [...(payload.stageListed ?? [])],
      head: hex,
    });
    this.syncDetails(threadId, state, { head: hex });
    return { ok: true, commit: hex };
  }

  command(
    payload: CommandPayload,
    fallbackFiles: readonly GitStatusFile[],
  ): Omit<CommandResult, "commandId"> | undefined {
    if (
      payload.type !== "git.stage" &&
      payload.type !== "git.unstage" &&
      payload.type !== "git.fetch"
    )
      return undefined;
    const threadId = payload.threadId;
    if (!this.context.thread(threadId)) return { ok: false, error: "thread_not_found" };
    const state = this.ensure(threadId, fallbackFiles);
    switch (payload.type) {
      case "git.stage": {
        const target = payload.paths ? new Set(payload.paths) : undefined;
        const move = (entry: GitStatusSectionEntry) => !target || target.has(entry.path);
        const nextStaged = new Map(state.staged.map((e) => [e.path, e]));
        for (const entry of state.unstaged.filter(move)) nextStaged.set(entry.path, entry);
        for (const entry of state.untracked.filter(move))
          nextStaged.set(entry.path, { ...entry, status: "added" });
        for (const entry of state.conflicted.filter(move))
          nextStaged.set(entry.path, { ...entry, status: "modified" });
        state.staged = byPath([...nextStaged.values()]);
        state.unstaged = state.unstaged.filter((e) => !move(e));
        state.untracked = state.untracked.filter((e) => !move(e));
        state.conflicted = state.conflicted.filter((e) => !move(e));
        this.syncDetails(threadId, state);
        return { ok: true };
      }
      case "git.unstage": {
        const target = payload.paths ? new Set(payload.paths) : undefined;
        const move = (entry: GitStatusSectionEntry) => !target || target.has(entry.path);
        const nextUnstaged = new Map(state.unstaged.map((e) => [e.path, e]));
        const nextUntracked = new Map(state.untracked.map((e) => [e.path, e]));
        for (const entry of state.staged.filter(move)) {
          if (entry.status === "added") {
            nextUntracked.set(entry.path, { ...entry, status: "untracked" });
          } else {
            nextUnstaged.set(entry.path, entry);
          }
        }
        state.staged = state.staged.filter((e) => !move(e));
        state.unstaged = byPath([...nextUnstaged.values()]);
        state.untracked = byPath([...nextUntracked.values()]);
        this.syncDetails(threadId, state);
        return { ok: true };
      }
      case "git.fetch": {
        if (state.fetchError) {
          // A fetch that failed on one remote still moved what it reached: details did not.
          if (state.fetchErrorBehind !== undefined) state.behind = state.fetchErrorBehind;
          return { ok: false, error: state.fetchError };
        }
        this.syncDetails(threadId, state);
        return { ok: true };
      }
    }
  }

  private syncDetails(
    threadId: string,
    state: ThreadSourceControl,
    extra: { branch?: string; head?: string } = {},
  ): void {
    const thread = this.context.thread(threadId)?.thread;
    if (!thread) return;
    const files = flatFilesOf(state);
    this.context.update(threadId, {
      type: "thread.client.updated",
      changes: {
        details: {
          ...thread.details,
          ...(extra.branch !== undefined ? { branch: extra.branch } : {}),
          ...(extra.head !== undefined ? { head: extra.head } : {}),
          ahead: state.ahead,
          behind: state.behind,
          diff: {
            files: files.length,
            additions: files.reduce((sum, file) => sum + file.additions, 0),
            deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          },
        },
      },
    });
  }
}
