import { fakeEmojiImages, resolveFakeMedia } from "./catalog/forge-media.ts";
import { fakeGitDiff } from "./git-diff-wire.ts";
import { FakeSourceControlDrafts } from "./source-control-drafts.ts";
import { FakeProjects } from "./projects.ts";
import {
  ForgeBrowserResult,
  ForgeIssueSearch,
  type ForgeBrowserOperation,
  gitStatusLimit,
  ServerMessage,
  InstalledEditor,
  type GitStatusFile,
  type WorkspaceActionRequest,
  type CommandPayload,
  type CommandResult,
  type ForgeCheckAction,
  type ThreadDetails,
  type ThreadId,
} from "@ace/protocol";
import { synthesizedStatus } from "./catalog/git-status.ts";
import { scriptOutput } from "./catalog/scripts.ts";
import { FakeForgeWire } from "./forge-wire.ts";
import { FakePrCatalog } from "./pr-catalog-wire.ts";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";
import { fakeOpenWork } from "./open-work-wire.ts";
import { emptyIssueList, FakeIssueWire } from "./issue-wire.ts";
import { FakeInboxWire } from "./inbox-wire.ts";
import { catalogIssueList, matchingIssues } from "./forge-list-wire.ts";
import { FakeTerminals } from "./terminals.ts";
import { FakeGitStates } from "./git-states.ts";
import { FakeConflicts } from "./conflict-wire.ts";
import type { FakeServiceContext } from "./service-context.ts";
const emptyDiff = { files: 0, additions: 0, deletions: 0 };

/** What tests and scenarios may steer of the fake workspace (`FakeDaemon.workspace`). */
export type FakeWorkspaceControls = Pick<
  FakeWorkspaceWire,
  | "gitStatus"
  | "setGitStatus"
  | "setGitDiff"
  | "setEditors"
  | "setForgeRead"
  | "holdForgeRead"
  | "failForgeRead"
  | "forgeReadCount"
  | "seedPullRequests"
  | "mergePullRequest"
  | "submitPullRequestReview"
  | "pushPullRequest"
  | "setDraftGenerator"
  | "setIssueOutcome"
  | "inbox"
  | "checkReruns"
  | "git"
  | "conflicts"
  | "failMoves"
  | "setDetails"
>;

export class FakeWorkspaceWire {
  readonly drafts = new FakeSourceControlDrafts();
  /** The projects' repositories as Git finds them: not one, empty, locked, failing setup. */
  readonly git = new FakeGitStates();
  /** Workflow re-runs the PR panel asked GitHub for (`forge.hosted.checks`), in order. */
  readonly checkReruns: ForgeCheckAction[] = [];
  /** Merge conflicts in PR checkouts (`git.conflicts`). */
  readonly conflicts = new FakeConflicts();
  private moveFailure: string | undefined;
  /** Every checkout move fails with `error` (its change kept as failed), or none does. */
  failMoves(error: string | undefined): void {
    this.moveFailure = error;
  }
  /** Change a thread's checkout facts, as the daemon's refresh would (a terminal commit). */
  setDetails(threadId: string, details: Partial<ThreadDetails>): void {
    const thread = this.context.thread(threadId)?.thread;
    this.context.update(threadId, {
      type: "thread.client.updated",
      changes: { details: { ...thread?.details, ...details } },
    });
  }
  setDraftGenerator(generate: FakeSourceControlDrafts["generate"]) {
    this.drafts.generate = generate;
  }
  readonly projects: FakeProjects;
  readonly terminals = new FakeTerminals();
  private context: FakeServiceContext;
  readonly forge: FakeForgeWire;
  constructor(context: FakeServiceContext) {
    this.context = context;
    this.projects = new FakeProjects(context, (id) => this.terminals.hasOwnedWork(id));
    this.forge = new FakeForgeWire(context);
    this.issues = new FakeIssueWire(this.forgeReads, () => context.now());
  }
  private forgeReads = new Map<string, ForgeBrowserResult>();
  /** GitHub notifications (`forge.inbox.list`, `forge.inbox.write`); empty until seeded. */
  readonly inbox = new FakeInboxWire();
  private issues: FakeIssueWire;
  setIssueOutcome(
    outcome: "succeeded" | "uncertain" | "unsent" | "busy" | "unauthorized" | "invalid" | "unknown",
  ): void {
    this.issues.setOutcome(outcome);
  }
  private pullRequests = new FakePrCatalog(() => this.context.now());
  /** Whole pull requests the fake app's PR panel can open (`pullRequestDetails`). */
  seedPullRequests(fixtures: readonly PullRequestFixture[]): void {
    this.pullRequests.seed(fixtures);
  }
  /** Push to a catalog PR's branch: a new head with every new-side line moved down by ten. */
  pushPullRequest(number: number): boolean {
    return this.pullRequests.push(number);
  }
  /** Another person reviews catalog PR `number` on GitHub (`FakePrCatalog.submitReview`). */
  submitPullRequestReview(
    number: number,
    review: Parameters<FakePrCatalog["submitReview"]>[1],
  ): void {
    this.pullRequests.submitReview(number, review);
  }
  /** Mark a catalog PR merged, as a Verify merge run does on GitHub. */
  mergePullRequest(number: number): void {
    this.pullRequests.mergeNumber(number);
  }
  /**
   * A seeded read asked for with the repository named, as a link from a PR page asks: the
   * catalog seeds `acme/ace`'s reads without it.
   */
  private withoutRepository(op: WorkspaceActionRequest["operation"]) {
    if (!("repository" in op) || !op.repository || op.repository.name !== "ace") return undefined;
    const { repository: _repository, ...rest } = op;
    return this.forgeReads.get(JSON.stringify(rest));
  }
  /** An issue's title, as the seeded issue reads have it. */
  private issueTitle(number: number): string | undefined {
    for (const read of this.forgeReads.values())
      if (read.resource === "issueDetail" && read.value.ref.number === number)
        return read.value.title;
    return undefined;
  }
  private seededRead(op: WorkspaceActionRequest["operation"]): ForgeBrowserResult | undefined {
    return (
      this.issues.read(op) ??
      this.forgeReads.get(JSON.stringify(op)) ??
      this.withoutRepository(op) ??
      (op.op === "forge.issue.list" ? catalogIssueList(op, this.forgeReads) : undefined) ??
      this.pullRequests.groupCounts(op, this.forgeReads) ??
      emptyIssueList(op)
    );
  }
  /**
   * A test scripted this PR's review state or detail with `setForgeRead`: its review commands
   * stay unanswered here (`unsupported_by_fake_daemon`) so the test decides their outcome.
   */
  private scriptedReview(payload: CommandPayload): boolean {
    if (payload.type !== "forge.hosted.review") return false;
    const repository = JSON.stringify(payload.pr.repository);
    for (const key of this.forgeReads.keys()) {
      const op: unknown = JSON.parse(key);
      if (
        typeof op === "object" &&
        op !== null &&
        "op" in op &&
        (op.op === "forge.pr.review-state" || op.op === "forge.pr.detail") &&
        "number" in op &&
        op.number === payload.pr.number &&
        "repository" in op &&
        JSON.stringify(op.repository) === repository
      )
        return true;
    }
    return false;
  }
  setForgeRead(operation: ForgeBrowserOperation, result: ForgeBrowserResult): void {
    this.forgeReads.set(JSON.stringify(operation), ForgeBrowserResult.parse(result));
  }
  private held = new Map<string, Promise<void>>();
  /**
   * Answer `operation` only once the returned release runs, as a slow GitHub would: every read
   * of it until then waits, and later ones are answered at once.
   */
  holdForgeRead(operation: ForgeBrowserOperation): () => void {
    const key = JSON.stringify(operation);
    const gate = Promise.withResolvers<void>();
    this.held.set(key, gate.promise);
    return () => {
      if (this.held.get(key) === gate.promise) this.held.delete(key);
      gate.resolve();
    };
  }
  private failing = new Map<string, string>();
  /**
   * Refuse `operation` with `code`, as GitHub refusing it would (`forge_rate_limit`), until the
   * returned undo runs.
   */
  failForgeRead(operation: ForgeBrowserOperation, code: string): () => void {
    const key = JSON.stringify(operation);
    this.failing.set(key, code);
    return () => {
      this.failing.delete(key);
    };
  }
  private forgeReadCounts = new Map<string, number>();
  /** How many times clients asked for this forge read, as GitHub would see them. */
  forgeReadCount(operation: ForgeBrowserOperation): number {
    return this.forgeReadCounts.get(JSON.stringify(operation)) ?? 0;
  }
  /** Browser fixtures cannot inspect the OS. Apps exist only when a scenario explicitly seeds them. */
  private editors: readonly InstalledEditor[] = [];
  setEditors(editors: readonly InstalledEditor[]): void {
    this.editors = InstalledEditor.array().max(32).parse(editors);
  }
  /** The project's scripts as the daemon lists them from package.json, by workspace. */
  private scriptOverrides = new Map<string, readonly string[]>();
  setScripts(workspaceId: string, names: readonly string[]): void {
    this.scriptOverrides.set(workspaceId, names);
  }
  /** Per thread, the files `git status` reports, once set or once a commit changed them. */
  private gitFiles = new Map<string, readonly GitStatusFile[]>();
  /** What `git status` reports for a thread's checkout (`git.status`). */
  setGitStatus(threadId: string, files: readonly GitStatusFile[]): void {
    this.gitFiles.set(threadId, files);
  }
  private gitPatches = new Map<string, string>();
  setGitDiff(threadId: string, patch: string): void {
    this.gitPatches.set(threadId, patch);
  }
  /** Every file, sorted by path as git lists them (`git.status` pages the first 500). */
  gitStatus(threadId: string): readonly GitStatusFile[] {
    return (
      this.gitFiles.get(threadId) ??
      synthesizedStatus(this.context.thread(threadId)?.thread.details?.diff ?? emptyDiff)
    ).toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  /** The checkout's HEAD as `git.status` reports it, when the thread records a commit id. */
  private head(threadId: string): string | null | undefined {
    return this.context.thread(threadId)?.thread.details?.head;
  }
  scripts(workspaceId: string | undefined) {
    const names =
      (workspaceId === undefined ? undefined : this.scriptOverrides.get(workspaceId)) ??
      (workspaceId === "relay"
        ? ["dev:relay", "test", "soak", "typecheck"]
        : ["dev", "test", "build", "typecheck"]);
    return names.map((name) => ({
      id: `package.json:${name}`,
      name,
      source: "package.json" as const,
      command: `bun run ${name}`,
    }));
  }
  async read(request: WorkspaceActionRequest) {
    const op = request.operation;
    if (op.op.startsWith("forge.")) {
      const key = JSON.stringify(op);
      this.forgeReadCounts.set(key, (this.forgeReadCounts.get(key) ?? 0) + 1);
    }
    const held = this.held.size ? this.held.get(JSON.stringify(op)) : undefined;
    if (held) await held;
    const failure = this.failing.size ? this.failing.get(JSON.stringify(op)) : undefined;
    if (failure)
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "error", code: failure },
      });
    if (op.op === "git.draft.cancel") {
      this.drafts.cancel(op.generationId);
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "draftCancelled" },
      });
    }
    if (op.op === "git.draft.context" || op.op === "git.draft.generate") {
      const selection = op.op === "git.draft.context" ? op.selection : op.input.selection;
      const context = await this.drafts.context(
        selection,
        this.context.thread(op.threadId)?.thread.details,
        selection.kind === "commit"
          ? selection.paths
          : this.gitStatus(op.threadId).map((file) => file.path),
        this.gitPatches.get(op.threadId) ?? "",
      );
      try {
        const result =
          op.op === "git.draft.context"
            ? { kind: "draftContext", context }
            : { kind: "draft", context, draft: await this.drafts.draft(op.input, context) };
        return ServerMessage.parse({
          type: "workspace.result",
          requestId: request.requestId,
          result,
        });
      } catch (error) {
        return ServerMessage.parse({
          type: "workspace.result",
          requestId: request.requestId,
          result: {
            kind: "error",
            code: error instanceof Error ? error.message : "draft_provider_failed",
          },
        });
      }
    }
    if (op.op === "workspaces.list")
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: this.projects.list(op.after, op.limit),
      });
    if (op.op === "workspace.origin") {
      const source = this.projects.source(op.workspaceId);
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: source
          ? { kind: "origin", url: (source.git && source.origin) || null }
          : { kind: "error", code: "workspace_not_found" },
      });
    }
    if (op.op === "workspaces.match")
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "match", workspaceId: this.projects.withOrigin(op.url)?.id ?? null },
      });
    if (op.op === "runs.list") {
      const all = Object.values(this.context.thread(op.threadId)?.runs ?? {}).filter(
        (run) => run.ordinal !== undefined,
      );
      const runs = all
        .filter((run) => (run.ordinal ?? 0) < op.before)
        .toSorted((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0));
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: {
          kind: "runs",
          total: all.length,
          runs: runs.slice(0, op.limit),
          ...(runs.length > op.limit ? { nextBefore: runs[op.limit - 1]?.ordinal } : {}),
        },
      });
    }
    const catalogued = this.forgeReads.has(JSON.stringify(op))
      ? undefined
      : (this.pullRequests.peopleRead(op, (state) =>
          "workspaceId" in op
            ? (matchingIssues(op, ForgeIssueSearch.parse({ state }), this.forgeReads) ?? [])
            : [],
        ) ??
        (op.op.startsWith("forge.pr.") ||
        op.op === "forge.repo.pr-options" ||
        op.op === "forge.repo.milestones" ||
        op.op === "forge.compare"
          ? this.pullRequests.read(op, this.context.now())
          : undefined));
    if (catalogued)
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "forge", data: catalogued },
      });
    if (op.op === "forge.pr.merge-state" && !this.forgeReads.has(JSON.stringify(op))) {
      const value = this.forge.mergeState(op.workspaceId, op.repository, op.number);
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: value
          ? { kind: "forge", data: { resource: "prMergeState", value } }
          : { kind: "error", code: "forge_not_found" },
      });
    }
    if (op.op === "forge.emoji.images" && !this.forgeReads.has(JSON.stringify(op)))
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "forge", data: { resource: "emojiImages", images: fakeEmojiImages } },
      });
    if (op.op === "forge.media.resolve" && !this.forgeReads.has(JSON.stringify(op)))
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "forge", data: { resource: "media", items: resolveFakeMedia(op.items) } },
      });
    if (op.op === "forge.open-work")
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "forge", data: fakeOpenWork(op, (list) => this.seededRead(list)) },
      });
    const inbox = this.inbox.read(op);
    if (inbox) await this.inbox.gate();
    if (inbox)
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result:
          "error" in inbox ? { kind: "error", code: inbox.error } : { kind: "forge", data: inbox },
      });
    if (op.op.startsWith("forge.")) {
      const data = this.seededRead(op);
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: data ? { kind: "forge", data } : { kind: "error", code: "forge_not_found" },
      });
    }
    if (op.op === "git.conflicts")
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: { kind: "gitConflicts", conflicts: this.conflicts.read(op.threadId) },
      });
    if (op.op === "git.diff")
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: fakeGitDiff(this.gitPatches.get(op.threadId) ?? "", op),
      });
    const result =
      op.op === "editors.list"
        ? { kind: "editors", editors: this.editors }
        : op.op === "scripts.list"
          ? {
              kind: "scripts",
              scripts: this.scripts(this.context.thread(op.threadId)?.thread.workspaceId),
            }
          : op.op === "branches.list"
            ? this.projects.isPlainCopy(op.workspaceId)
              ? { kind: "error" as const, code: "git_not_a_repo" }
              : this.git.branches(op.workspaceId)
            : op.op === "pr.status"
              ? { kind: "pr", status: this.forge.status(op.threadId) }
              : op.op === "git.status"
                ? {
                    kind: "gitStatus",
                    files: this.gitStatus(op.threadId).slice(0, gitStatusLimit),
                    truncated: this.gitStatus(op.threadId).length > gitStatusLimit,
                    head: this.head(op.threadId),
                    hooks: this.git.hooks(op.threadId),
                  }
                : op.op === "thread.details"
                  ? {
                      kind: "details",
                      details: this.context.thread(op.threadId)?.thread.details ?? {},
                    }
                  : { kind: "error", code: "unsupported" };
    return ServerMessage.parse({ type: "workspace.result", requestId: request.requestId, result });
  }
  command(
    payload: CommandPayload,
    commandId = "fixture",
  ): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type === "workspace.git.lock.clear") {
      if (!this.projects.get(payload.workspaceId))
        return { ok: false, error: "workspace_not_found" };
      return { ok: true, locksCleared: this.git.clearLock(payload.workspaceId) ? 1 : 0 };
    }
    if (payload.type === "forge.hosted.checks") {
      this.checkReruns.push(payload.action);
      return { ok: true };
    }
    const merged =
      this.pullRequests.merge(payload) ??
      this.pullRequests.mergeState(payload) ??
      this.pullRequests.lifecycle(
        payload,
        (number) => this.issueTitle(number),
        this.context.now(),
      ) ??
      this.pullRequests.create(payload, this.context.now()) ??
      // A scripted review answer wins; otherwise the catalog's review actions, then guarded edits.
      (this.scriptedReview(payload)
        ? undefined
        : (this.pullRequests.review(payload, commandId) ?? this.pullRequests.edit(payload)));
    if (merged) return merged;
    const project = this.projects.command(payload);
    if (project) return project;
    const forge = this.forge.command(payload);
    if (forge) return forge;
    const issue = this.issues.command(payload, commandId);
    if (issue) return issue;
    const inboxWrite = this.inbox.command(payload, commandId);
    if (inboxWrite) return inboxWrite;
    if (!("threadId" in payload) || !payload.threadId) return undefined;
    const thread = this.context.thread(payload.threadId)?.thread;
    if (
      ["workspace.editor.open", "workspace.script.run", "git.commit", "git.push"].includes(
        payload.type,
      ) &&
      !thread
    )
      return { ok: false, error: "thread_not_found" };
    if (payload.type === "thread.workspace.set") {
      const view = this.context.thread(payload.threadId);
      if (!view || view.thread.deletedAt !== undefined)
        return { ok: false, error: "thread_not_found" };
      if (
        !["new", "done", "failed"].includes(view.thread.status.state) ||
        this.terminals.hasOwnedWork(payload.threadId)
      )
        return { ok: false, error: "thread_tree_is_live" };
      const details = view.thread.details ?? {};
      if (!payload.allowUncommitted && (details.diff?.files ?? 0) > 0)
        return { ok: false, error: "git_dirty_worktree" };
      if (payload.branch && !["main", "develop"].includes(payload.branch))
        return { ok: false, error: "git_invalid_ref" };
      const change = {
        commandId,
        at: this.context.now(),
        lossy: true,
        mode: payload.mode,
        ...(payload.branch ? { branch: payload.branch } : {}),
      };
      if (this.moveFailure) {
        const error = this.moveFailure;
        this.context.update(payload.threadId, {
          type: "thread.client.updated",
          changes: {
            details: { ...details, workspaceChange: { ...change, state: "failed", error } },
          },
        });
        return { ok: false, error };
      }
      for (const state of ["preparing", "applied"] as const)
        this.context.update(payload.threadId, {
          type: "thread.client.updated",
          changes: {
            details: {
              ...details,
              mode: payload.mode,
              branch: payload.branch ?? details.branch ?? "main",
              worktree:
                payload.mode === "worktree"
                  ? `/fake/worktrees/${payload.threadId}`
                  : `/fake/${view.thread.workspaceId}`,
              workspaceChange: { ...change, state },
              worktreeMissing: undefined,
            },
          },
        });
      return { ok: true, threadId: payload.threadId };
    }
    if (payload.type === "thread.workspace.setup") {
      const details = thread?.details;
      if (details?.worktreeSetup?.state !== "failed") return { ok: false, error: "settled" };
      // The fake's setup passes on Retry; Continue skips it. Either way the failure is gone.
      const { worktreeSetup: _resolved, ...rest } = details;
      this.context.update(payload.threadId, {
        type: "thread.client.updated",
        changes: { details: rest },
      });
      return { ok: true, threadId: payload.threadId };
    }
    if (payload.type === "thread.workspace.clear") {
      const details = thread?.details;
      if (!thread || !details) return { ok: false, error: "thread_not_found" };
      const { workspaceChange: _cleared, ...rest } = details;
      this.context.update(payload.threadId, {
        type: "thread.client.updated",
        changes: { details: rest },
      });
      return { ok: true };
    }
    if (payload.type === "workspace.editor.open") {
      const editor = this.editors.find((entry) => entry.id === payload.editorId);
      return editor
        ? {
            ok: true,
            editor: { editor, path: thread?.details?.worktree ?? `/fake/${thread?.workspaceId}` },
          }
        : { ok: false, error: "editor_not_found" };
    }
    if (payload.type === "workspace.script.run") {
      const script = this.scripts(thread?.workspaceId).find(
        (entry) => entry.id === payload.scriptId,
      );
      if (!script) return { ok: false, error: "script_not_found" };
      const terminal = this.terminals.openNow({
        threadId: payload.threadId,
        name: script.name,
        cwd: thread?.details?.worktree ?? "/fake",
        cols: 80,
        rows: 24,
      });
      this.terminals.output(terminal.id, `${script.command}\r\n`);
      const printed = scriptOutput(script.name);
      if (printed.text) this.terminals.output(terminal.id, printed.text);
      if (printed.done) this.terminals.prompt(terminal.id);
      return { ok: true, terminalId: terminal.id };
    }
    if (payload.type === "git.conflicts") return this.conflicts.command(payload);
    if (payload.type === "git.commit") {
      if ((thread?.details?.head ?? null) !== payload.expectedHead)
        return { ok: false, error: "git_head_moved" };
      const commit = "a".repeat(40);
      // Only the paths named are committed; the rest stay uncommitted, as with git. A rename
      // named by one of its paths splits: the half not named stays (its old path a deletion,
      // its new one an addition).
      const named = payload.paths && new Set(payload.paths);
      const left = named
        ? this.gitStatus(payload.threadId).flatMap((file): GitStatusFile[] => {
            if (!file.from) return named.has(file.path) ? [] : [file];
            const added = named.has(file.path);
            const removed = named.has(file.from);
            if (added && removed) return [];
            if (!added && !removed) return [file];
            const { from, ...rest } = file;
            return added
              ? [{ path: from, status: "deleted", additions: 0, deletions: 0, binary: false }]
              : [{ ...rest, status: "added" }];
          })
        : [];
      this.gitFiles.set(payload.threadId, left);
      this.context.update(payload.threadId, {
        type: "thread.client.updated",
        changes: {
          details: {
            ...thread?.details,
            head: commit,
            ahead: (thread?.details?.ahead ?? 0) + 1,
            diff: {
              files: left.length,
              additions: left.reduce((sum, file) => sum + file.additions, 0),
              deletions: left.reduce((sum, file) => sum + file.deletions, 0),
            },
          },
        },
      });
      return { ok: true, commit };
    }
    if (payload.type === "git.push") {
      const refused = this.git.pushRefusal(payload.threadId, payload.force);
      if (refused) return refused;
      this.context.update(payload.threadId, {
        type: "thread.client.updated",
        changes: { details: { ...thread?.details, ahead: 0 } },
      });
      return { ok: true };
    }
    // The fixture has no stopped daemons' locks; clearing one finds its owner gone.
    if (payload.type === "git.lock.clear")
      return thread ? { ok: true, locksCleared: 1 } : { ok: false, error: "thread_not_found" };
    return undefined;
  }
  descriptor(id: string, threadId: ThreadId) {
    const terminal = this.terminals.list(threadId).find((entry) => entry.id === id);
    if (!terminal) throw new Error("terminal_not_found");
    return {
      id,
      threadId,
      name: terminal.name,
      pid: 1,
      exited: terminal.exitCode !== null,
      ...this.terminals.offsets(id),
    };
  }
}
