import type {
  BranchRef,
  CommandPayload,
  CommandResult,
  GitStashEntry,
  GitStatusFile,
  GitStatusSectionEntry,
} from "@ace/protocol";
import { fakeBranchRefs } from "./worktree-base.ts";
import type { FakeServiceContext } from "./service-context.ts";

export interface FakeSourceControlSeed {
  branch?: string | undefined;
  staged?: readonly GitStatusSectionEntry[] | undefined;
  unstaged?: readonly GitStatusSectionEntry[] | undefined;
  untracked?: readonly GitStatusSectionEntry[] | undefined;
  conflicted?: readonly GitStatusSectionEntry[] | undefined;
  stashes?: readonly GitStashEntry[] | undefined;
  branches?: readonly string[] | undefined;
  refs?: readonly BranchRef[] | undefined;
  upstream?: string | null | undefined;
  ahead?: number | undefined;
  behind?: number | undefined;
  detached?: boolean | undefined;
  pullError?: string | undefined;
}

interface ThreadSourceControl {
  staged: GitStatusSectionEntry[];
  unstaged: GitStatusSectionEntry[];
  untracked: GitStatusSectionEntry[];
  conflicted: GitStatusSectionEntry[];
  stashes: {
    entry: GitStashEntry;
    staged: GitStatusSectionEntry[];
    unstaged: GitStatusSectionEntry[];
    untracked: GitStatusSectionEntry[];
  }[];
  branches: string[];
  refs: BranchRef[];
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  pullError?: string | undefined;
  commits: { message: string; amend: boolean; stagedOnly: boolean; head: string }[];
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

function isBusy(state: string | undefined): boolean {
  return state === "working" || state === "needs_you" || state === "waiting";
}

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
        stashes: [],
        branches: [...new Set([branch, "main", "develop"])],
        refs: [...fakeBranchRefs],
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
    if (seed.stashes !== undefined) {
      state.stashes = seed.stashes.map((entry) => ({
        entry,
        staged: [],
        unstaged: [],
        untracked: [],
      }));
    }
    if (seed.branches !== undefined) state.branches = [...seed.branches];
    if (seed.refs !== undefined) state.refs = [...seed.refs];
    if (seed.upstream !== undefined) state.upstream = seed.upstream;
    if (seed.ahead !== undefined) state.ahead = seed.ahead;
    if (seed.behind !== undefined) state.behind = seed.behind;
    if (seed.detached !== undefined) state.detached = seed.detached;
    if (seed.pullError !== undefined) state.pullError = seed.pullError;
    this.syncDetails(threadId, state);
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

  branches(threadId: string) {
    const state = this.ensure(threadId, []);
    const thread = this.context.thread(threadId)?.thread;
    const current = state.detached ? null : (thread?.details?.branch ?? "main");
    return {
      kind: "branches" as const,
      branches: [...state.branches],
      truncated: false,
      refs: [...state.refs],
      defaultBranch: "main",
      current,
      detached: state.detached,
      unbornHead: false,
    };
  }

  stashes(threadId: string) {
    const state = this.states.get(threadId);
    return {
      kind: "gitStashes" as const,
      stashes: (state?.stashes ?? []).map((item, index): GitStashEntry =>
        item.entry.branch !== undefined
          ? {
              ref: `stash@{${index}}`,
              index,
              message: item.entry.message,
              branch: item.entry.branch,
            }
          : {
              ref: `stash@{${index}}`,
              index,
              message: item.entry.message,
            },
      ),
    };
  }

  commit(
    threadId: string,
    payload: Extract<CommandPayload, { type: "git.commit" }>,
    fallbackFiles: readonly GitStatusFile[],
  ): Omit<CommandResult, "commandId"> | undefined {
    if (!this.states.has(threadId) && !payload.stagedOnly && !payload.amend) return undefined;
    const thread = this.context.thread(threadId)?.thread;
    if ((thread?.details?.head ?? null) !== payload.expectedHead) {
      return { ok: false, error: "git_head_moved" };
    }
    const state = this.ensure(threadId, fallbackFiles);
    if (state.conflicted.length > 0) return { ok: false, error: "git_conflicts" };
    if (payload.amend && !thread?.details?.head) return { ok: false, error: "git_unborn_head" };
    if (payload.stagedOnly && !payload.paths) {
      if (!payload.amend && state.staged.length === 0) {
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
        !payload.amend &&
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
    if (!payload.amend) state.ahead += 1;
    state.commits.push({
      message: payload.message,
      amend: Boolean(payload.amend),
      stagedOnly: Boolean(payload.stagedOnly),
      head: hex,
    });
    this.syncDetails(threadId, state, { head: hex });
    return { ok: true, commit: hex };
  }

  command(
    payload: CommandPayload,
    fallbackFiles: readonly GitStatusFile[],
  ): Omit<CommandResult, "commandId"> | undefined {
    if (!("threadId" in payload) || !payload.threadId) return undefined;
    const threadId = payload.threadId;
    const thread = this.context.thread(threadId)?.thread;

    if (
      payload.type === "git.stage" ||
      payload.type === "git.unstage" ||
      payload.type === "git.discard" ||
      payload.type === "git.branch.switch" ||
      payload.type === "git.branch.create" ||
      payload.type === "git.pull" ||
      payload.type === "git.fetch" ||
      payload.type === "git.stash.push" ||
      payload.type === "git.stash.pop"
    ) {
      if (!thread) return { ok: false, error: "thread_not_found" };
      if (
        (payload.type === "git.branch.switch" ||
          payload.type === "git.branch.create" ||
          payload.type === "git.pull" ||
          payload.type === "git.stash.push" ||
          payload.type === "git.stash.pop") &&
        isBusy(thread.status.state)
      ) {
        return { ok: false, error: "agent_working" };
      }
      const state = this.ensure(threadId, fallbackFiles);

      switch (payload.type) {
        case "git.stage": {
          const target = payload.paths ? new Set(payload.paths) : undefined;
          const move = (entry: GitStatusSectionEntry) => !target || target.has(entry.path);
          const nextStaged = new Map(state.staged.map((e) => [e.path, e]));
          for (const entry of state.unstaged.filter(move)) nextStaged.set(entry.path, entry);
          for (const entry of state.untracked.filter(move))
            nextStaged.set(entry.path, { path: entry.path, status: "added" });
          for (const entry of state.conflicted.filter(move))
            nextStaged.set(entry.path, { path: entry.path, status: "modified" });
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
              nextUntracked.set(entry.path, { path: entry.path, status: "untracked" });
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
        case "git.discard": {
          if (payload.paths) {
            const target = new Set(payload.paths);
            state.unstaged = state.unstaged.filter((e) => !target.has(e.path));
            state.untracked = state.untracked.filter((e) => !target.has(e.path));
          } else {
            state.unstaged = [];
            if (payload.includeUntracked) state.untracked = [];
          }
          this.syncDetails(threadId, state);
          return { ok: true };
        }
        case "git.branch.switch": {
          if (!state.branches.includes(payload.branch) && !payload.remote) {
            return { ok: false, error: "git_invalid_ref" };
          }
          if (!state.branches.includes(payload.branch)) state.branches.push(payload.branch);
          state.detached = false;
          state.upstream = payload.remote
            ? `${payload.remote}/${payload.branch}`
            : `origin/${payload.branch}`;
          this.syncDetails(threadId, state, { branch: payload.branch });
          return { ok: true };
        }
        case "git.branch.create": {
          if (state.branches.includes(payload.branch)) {
            return { ok: false, error: "git_branch_exists" };
          }
          state.branches.push(payload.branch);
          state.refs.unshift({ name: payload.branch, ahead: 0, behind: 0 });
          state.detached = false;
          state.upstream = null;
          state.ahead = 0;
          state.behind = 0;
          this.syncDetails(threadId, state, { branch: payload.branch });
          return { ok: true };
        }
        case "git.pull": {
          if (state.pullError) return { ok: false, error: state.pullError };
          if (!state.upstream && !payload.remote) return { ok: false, error: "git_no_upstream" };
          state.behind = 0;
          this.syncDetails(threadId, state);
          return { ok: true };
        }
        case "git.fetch": {
          this.syncDetails(threadId, state);
          return { ok: true };
        }
        case "git.stash.push": {
          const hasChanges =
            state.staged.length > 0 ||
            state.unstaged.length > 0 ||
            (payload.includeUntracked && state.untracked.length > 0);
          if (!hasChanges) return { ok: false, error: "git_nothing_to_stash" };
          const branch = thread.details?.branch ?? "main";
          const captured = {
            entry: {
              ref: "stash@{0}",
              index: 0,
              message: payload.message?.trim() || `WIP on ${branch}`,
              branch,
            },
            staged: [...state.staged],
            unstaged: [...state.unstaged],
            untracked: payload.includeUntracked ? [...state.untracked] : [],
          };
          state.stashes.unshift(captured);
          state.staged = [];
          state.unstaged = [];
          if (payload.includeUntracked) state.untracked = [];
          this.syncDetails(threadId, state);
          return { ok: true };
        }
        case "git.stash.pop": {
          if (state.stashes.length === 0) return { ok: false, error: "git_stash_empty" };
          const idx = payload.stash
            ? Number(/^stash@\{(\d+)\}$/.exec(payload.stash)?.[1] ?? -1)
            : 0;
          const popped = state.stashes[idx];
          if (!popped) return { ok: false, error: "git_stash_empty" };
          state.stashes.splice(idx, 1);
          state.staged = byPath([...state.staged, ...popped.staged]);
          state.unstaged = byPath([...state.unstaged, ...popped.unstaged]);
          state.untracked = byPath([...state.untracked, ...popped.untracked]);
          this.syncDetails(threadId, state);
          return { ok: true };
        }
      }
    }
    return undefined;
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
