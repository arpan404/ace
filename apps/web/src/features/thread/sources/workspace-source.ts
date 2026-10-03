// TODO(train-2): wire to protocol when merged. Scripts, editors, git and forge have no
// daemon messages on main yet (forge commands exist in @ace/protocol but are not routed).
import { z } from "zod";

export interface ThreadRef {
  id: string;
  workspaceId: string;
  title: string;
}

export interface Script {
  name: string;
  command: string;
}
export const EditorId = z.enum(["cursor", "vscode", "zed", "xcode", "finder", "terminal"]);
export type EditorId = z.infer<typeof EditorId>;
export interface Editor {
  id: EditorId;
  name: string;
}
export interface PullRequest {
  number: number;
  state: "open" | "draft" | "merged" | "closed";
  url: string;
}
/** What the thread's checkout looks like, from git and the forge. */
export interface GitState {
  mode: "worktree" | "local";
  branch: string;
  branches: readonly string[];
  /** Files with uncommitted changes. */
  changed: number;
  /** Commits not on the remote. */
  ahead: number;
  pr?: PullRequest | undefined;
}
export type GitAction = "commit" | "commit-push" | "push" | "create-pr" | "create-draft-pr";

export interface WorkspaceSource {
  scripts(thread: ThreadRef): Promise<readonly Script[]>;
  /** Starts the script in a terminal in the thread's checkout. */
  runScript(thread: ThreadRef, script: Script): Promise<void>;
  editors(): Promise<{ editors: readonly Editor[]; defaultEditor: EditorId }>;
  /** Opens the checkout in an editor and remembers it as the default. */
  openIn(thread: ThreadRef, editor: EditorId): Promise<void>;
  git(thread: ThreadRef): Promise<GitState>;
  /** Commit messages and PR descriptions are written by the agent. */
  gitAction(thread: ThreadRef, action: GitAction): Promise<GitState>;
  switchBranch(thread: ThreadRef, branch: string): Promise<GitState>;
  setMode(thread: ThreadRef, mode: GitState["mode"]): Promise<GitState>;
}

/** The control the header shows for a checkout: the next step towards a merged PR. */
export function nextGitStep(
  git: GitState,
): { action: GitAction; label: string } | { pr: PullRequest } {
  if (git.pr) return { pr: git.pr };
  if (git.changed > 0) return { action: "commit", label: "Commit" };
  if (git.ahead > 0) return { action: "push", label: "Push" };
  return { action: "create-pr", label: "Create PR" };
}

const editors: readonly Editor[] = [
  { id: "cursor", name: "Cursor" },
  { id: "vscode", name: "VS Code" },
  { id: "zed", name: "Zed" },
  { id: "xcode", name: "Xcode" },
  { id: "finder", name: "Finder" },
  { id: "terminal", name: "Terminal" },
];

const scriptsByProject: Record<string, readonly Script[]> = {
  relay: [
    { name: "dev:relay", command: "bun run dev:relay" },
    { name: "test", command: "bun run test" },
    { name: "soak", command: "bun run soak --subscribers 500" },
    { name: "typecheck", command: "bun run typecheck" },
  ],
};
const defaultScripts: readonly Script[] = [
  { name: "dev", command: "bun run dev" },
  { name: "test", command: "bun run test" },
  { name: "build", command: "bun run build" },
  { name: "typecheck", command: "bun run typecheck" },
];

const knownCheckouts: Record<string, Partial<GitState>> = {
  "thread-replay-cursor": {
    branch: "fix/replay-cursor",
    changed: 0,
    ahead: 0,
    pr: { number: 214, state: "open", url: "https://github.com/acme/relay/pull/214" },
  },
  "thread-dedupe": {
    branch: "fix/replay-dedupe",
    changed: 0,
    ahead: 0,
    pr: { number: 214, state: "open", url: "https://github.com/acme/ace/pull/214" },
  },
  "thread-retry-budget": {
    branch: "fix/restart-retry",
    pr: { number: 188, state: "open", url: "https://github.com/acme/relay/pull/188" },
  },
  "thread-checkout": { branch: "fix/checkout-flake", changed: 3, ahead: 0 },
};

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 3)
    .join("-");
}

function initialGit(thread: ThreadRef): GitState {
  const known = knownCheckouts[thread.id] ?? {};
  const branch = known.branch ?? `fix/${slug(thread.title) || "thread"}`;
  return {
    mode: "worktree",
    branch,
    branches: [branch, "main", "release/0.9"],
    changed: 2,
    ahead: 0,
    ...known,
  };
}

/** In-memory scripts, editors and checkouts with realistic content, for dev:fake and tests. */
export function fakeWorkspaceSource(
  options: { onRun?: (thread: ThreadRef, script: Script) => void } = {},
): WorkspaceSource {
  const checkouts = new Map<string, GitState>();
  let defaultEditor: EditorId = "cursor";
  let prs = 220;
  const git = (thread: ThreadRef) => {
    const existing = checkouts.get(thread.id);
    if (existing) return existing;
    const created = initialGit(thread);
    checkouts.set(thread.id, created);
    return created;
  };
  const update = (thread: ThreadRef, patch: Partial<GitState>) => {
    const next = { ...git(thread), ...patch };
    checkouts.set(thread.id, next);
    return Promise.resolve(next);
  };
  const pr = (thread: ThreadRef, draft: boolean): PullRequest => ({
    number: ++prs,
    state: draft ? "draft" : "open",
    url: `https://github.com/acme/${thread.workspaceId}/pull/${prs}`,
  });
  return {
    scripts: (thread) => Promise.resolve(scriptsByProject[thread.workspaceId] ?? defaultScripts),
    runScript: (thread, script) => {
      options.onRun?.(thread, script);
      return Promise.resolve();
    },
    editors: () => Promise.resolve({ editors, defaultEditor }),
    openIn: (_thread, editor) => {
      defaultEditor = editor;
      return Promise.resolve();
    },
    git: (thread) => Promise.resolve(git(thread)),
    gitAction: (thread, action) => {
      const current = git(thread);
      switch (action) {
        case "commit":
          return update(thread, { changed: 0, ahead: current.ahead + 1 });
        case "commit-push":
        case "push":
          return update(thread, { changed: 0, ahead: 0 });
        case "create-pr":
        case "create-draft-pr":
          return update(thread, {
            changed: 0,
            ahead: 0,
            pr: pr(thread, action === "create-draft-pr"),
          });
      }
    },
    switchBranch: (thread, branch) => update(thread, { branch }),
    setMode: (thread, mode) => update(thread, { mode }),
  };
}
