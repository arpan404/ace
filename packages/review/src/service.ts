import { GitService, type DiffResult } from "@ace/git";
import {
  Command,
  ReviewCommand,
  ReviewSession,
  ReviewComment,
  type CommandResult,
  type ReviewSource,
  type ReviewRevision,
  type ReviewData,
} from "@ace/protocol";
import { anchorComment, anchorComments, reanchorComments } from "./anchors.ts";
import { buildFixIntent, parseReviewerOutput, type ReviewExecutor } from "./intents.ts";
import { suggestionPatch } from "./suggestions.ts";
import { ReviewStore } from "./store.ts";

export interface ReviewOptions {
  path: string;
  git?: GitService;
  now: () => number;
  id: () => string;
  executor?: ReviewExecutor;
}
export class ReviewService {
  private readonly store: ReviewStore;
  private readonly git: GitService;
  private readonly lifetime = new AbortController();
  private tail = Promise.resolve();
  private admitted = 0;
  private readonly options: ReviewOptions;
  constructor(options: ReviewOptions) {
    this.options = options;
    this.store = new ReviewStore(options.path);
    this.git = options.git ?? new GitService();
  }
  close() {
    this.lifetime.abort();
    this.store.close();
  }
  handle(input: unknown, worktree?: string): Promise<CommandResult> {
    const command = Command.parse(input);
    if (this.admitted >= 16)
      return Promise.resolve({ commandId: command.id, ok: false, error: "review_busy" });
    this.admitted++;
    const result = this.tail.then(() => this.executeCommand(command, worktree));
    this.tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.admitted--;
      });
    return result;
  }
  private async executeCommand(input: unknown, worktree?: string): Promise<CommandResult> {
    const command = Command.parse(input);
    const payload = ReviewCommand.parse(command.payload);
    const receipt = this.store.begin(command.id, command.deviceId);
    if (receipt) return receipt;
    let result: CommandResult;
    try {
      const review = await this.execute(payload, command.id, worktree);
      result = { commandId: command.id, ok: true, review };
    } catch (error) {
      const message =
        error instanceof Error && /^review_[a-z_]+$/.test(error.message)
          ? error.message
          : "review_rejected";
      result = { commandId: command.id, ok: false, error: message };
    }
    this.store.finish(result);
    return result;
  }
  private async freeze(
    worktree: string,
    revision: ReviewRevision,
    threadId: string,
  ): Promise<ReviewRevision> {
    if (revision.kind === "commit")
      return { kind: "commit", ref: await this.git.resolveCommit({ worktree, ref: revision.ref }) };
    if (revision.kind === "checkpoint") return revision;
    const checkpoint = await this.git.createCheckpoint({
      worktree,
      threadId,
      label: "Review snapshot",
    });
    return { kind: "checkpoint", id: checkpoint.id };
  }
  private async diff(worktree: string, source: ReviewSource): Promise<DiffResult> {
    const diff = await this.git.diff({
      worktree,
      from: source.from,
      to: source.to,
      maxPatchBytes: 1024 * 1024,
    });
    if (diff.truncated) throw new Error("review_diff_too_large");
    return diff;
  }
  private async execute(
    p: ReviewCommand,
    requestId: string,
    suppliedWorktree?: string,
  ): Promise<ReviewData> {
    if (p.type === "review.open") {
      if (!suppliedWorktree) throw new Error("review_workspace_not_found");
      const sessionId = this.options.id();
      const from = await this.freeze(
        suppliedWorktree,
        p.source.from,
        p.source.threadId ?? sessionId,
      );
      const to =
        p.source.to.kind === "working-tree" && p.source.from.kind === "working-tree"
          ? from
          : await this.freeze(suppliedWorktree, p.source.to, p.source.threadId ?? sessionId);
      const source = { ...p.source, from, to };
      await this.diff(suppliedWorktree, source);
      const session = ReviewSession.parse({
        id: sessionId,
        source,
        status: "open",
        createdAt: this.options.now(),
      });
      this.store.putSession(session, suppliedWorktree);
      return { session };
    }
    if (p.type === "review.list") return this.store.list(p);
    const { session, worktree } = this.store.session(p.sessionId);
    if (p.type === "review.status") {
      session.status = p.status;
      this.store.putSession(session, worktree);
      return { session };
    }
    if (p.type === "review.comment") {
      const diff = await this.diff(worktree, session.source);
      const anchor = anchorComment(
        diff,
        p.position,
        p.position.side === "old" ? session.source.from : session.source.to,
      );
      const comment = ReviewComment.parse({
        id: this.options.id(),
        sessionId: session.id,
        anchor,
        originalAnchor: anchor,
        text: p.text,
        suggestion: p.suggestion,
        resolved: false,
      });
      this.store.insertComment(comment);
      return { comment };
    }
    if (p.type === "review.refresh") {
      const from = await this.freeze(worktree, p.from, session.source.threadId ?? session.id);
      const to = await this.freeze(worktree, p.to, session.source.threadId ?? session.id);
      const source = { ...session.source, from, to };
      await this.diff(worktree, source);
      const comments = this.store.allComments(session.id);
      const next: ReviewComment[] = [];
      for (const side of ["old", "new"] as const) {
        const selected = comments.filter((c) => c.anchor.position.side === side);
        if (!selected.length) continue;
        const revision = side === "old" ? from : to;
        const diff = await this.git.diff({
          worktree,
          from: side === "old" ? session.source.from : session.source.to,
          to: revision,
          maxPatchBytes: 1024 * 1024,
        });
        const anchors = reanchorComments(
          selected.map((c) => c.anchor),
          diff,
          revision,
        );
        selected.forEach((comment, offset) => {
          const anchor = anchors[offset];
          if (anchor) next.push({ ...comment, anchor });
        });
      }
      session.source = source;
      this.store.transaction(() => {
        for (const comment of next) this.store.putComment(comment);
        this.store.putSession(session, worktree);
      });
      return { session };
    }
    if (p.type === "review.sendToAgent") {
      if (!this.options.executor) throw new Error("review_executor_unavailable");
      const intent = buildFixIntent(
        requestId,
        session.id,
        p.threadId,
        p.commentIds.map((id) => this.store.comment(session.id, id)),
      );
      await this.options.executor.fix(intent, this.lifetime.signal);
      session.status = "changes-requested";
      this.store.putSession(session, worktree);
      return { session, intentId: requestId };
    }
    if (p.type === "review.askReviewer") {
      if (!this.options.executor) throw new Error("review_executor_unavailable");
      const diff = await this.diff(worktree, session.source);
      if (Buffer.byteLength(diff.patch) > 65_536) throw new Error("review_reviewer_diff_too_large");
      const output = parseReviewerOutput(
        await this.options.executor.review(
          {
            kind: "review-run",
            requestId,
            sessionId: session.id,
            threadId: p.threadId,
            diff: diff.patch,
          },
          this.lifetime.signal,
        ),
      );
      const anchors = anchorComments(
        diff,
        output.comments.map((finding) => finding.position),
        session.source.from,
        session.source.to,
      );
      const comments = output.comments.map((finding, offset) => {
        const anchor = anchors[offset];
        if (!anchor) throw new Error("review_lines_not_visible");
        return ReviewComment.parse({
          ...finding,
          id: this.options.id(),
          sessionId: session.id,
          anchor,
          originalAnchor: anchor,
          resolved: false,
        });
      });
      this.store.transaction(() => {
        for (const comment of comments) this.store.insertComment(comment);
      });
      return { session };
    }
    const comment = this.store.comment(session.id, p.commentId);
    if (p.type === "review.reply") {
      const reply = { id: this.options.id(), commentId: comment.id, text: p.text };
      this.store.reply(reply);
      return { reply };
    }
    if (p.type === "review.resolve") {
      comment.resolved = p.resolved;
      this.store.putComment(comment);
      return { comment };
    }
    const transition = await this.git.diff({
      worktree,
      from: session.source.to,
      to: { kind: "working-tree" },
      maxPatchBytes: 1024 * 1024,
    });
    const current = reanchorComments([comment.anchor], transition, { kind: "working-tree" })[0];
    if (
      !current ||
      current.state === "outdated" ||
      current.fingerprint.lines.join("\n") !== comment.anchor.fingerprint.lines.join("\n")
    )
      throw new Error("review_suggestion_conflict");
    const updated = { ...comment, anchor: current };
    await this.git.applyPatch({ worktree, patch: suggestionPatch(updated) });
    comment.anchor.state = "addressed-pending-review";
    this.store.putComment(comment);
    return { comment };
  }
}
