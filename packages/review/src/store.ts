import { DatabaseSync } from "node:sqlite";
import {
  CommandResult,
  type CommandId,
  ReviewComment,
  ReviewReply,
  ReviewSession,
  type ReviewData,
} from "@ace/protocol";

export class ReviewStore {
  private readonly db: DatabaseSync;
  private readonly statements;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS review_sessions (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_comments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES review_sessions(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_comments_session ON review_comments(session_id, id);
      CREATE TABLE IF NOT EXISTS review_replies (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES review_comments(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_replies_comment ON review_replies(comment_id, id);
      CREATE TABLE IF NOT EXISTS review_receipts (id TEXT PRIMARY KEY, device TEXT NOT NULL, result TEXT);
    `);
    this.statements = {
      session: this.db.prepare("SELECT data, worktree FROM review_sessions WHERE id = ?"),
      putSession: this.db.prepare(
        "INSERT INTO review_sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      ),
      comment: this.db.prepare("SELECT data FROM review_comments WHERE id = ? AND session_id = ?"),
      putComment: this.db.prepare(
        "INSERT INTO review_comments VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      ),
      countComments: this.db.prepare(
        "SELECT COUNT(*) AS n FROM review_comments WHERE session_id = ?",
      ),
      countReplies: this.db.prepare(
        "SELECT COUNT(*) AS n FROM review_replies WHERE comment_id = ?",
      ),
      putReply: this.db.prepare("INSERT INTO review_replies VALUES (?, ?, ?)"),
      sessions: this.db.prepare(
        "SELECT data FROM review_sessions WHERE id > ? ORDER BY id LIMIT ?",
      ),
      comments: this.db.prepare(
        "SELECT data FROM review_comments WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?",
      ),
      replies: this.db.prepare(
        "SELECT data FROM review_replies WHERE comment_id = ? AND id > ? ORDER BY id LIMIT ?",
      ),
      receipt: this.db.prepare("SELECT device, result FROM review_receipts WHERE id = ?"),
      begin: this.db.prepare("INSERT INTO review_receipts VALUES (?, ?, NULL)"),
      finish: this.db.prepare("UPDATE review_receipts SET result = ? WHERE id = ?"),
    };
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  session(id: string): { session: ReviewSession; worktree: string } {
    const row = this.statements.session.get(id);
    if (!row || typeof row.worktree !== "string") throw new Error("review_session_not_found");
    return { session: ReviewSession.parse(JSON.parse(String(row.data))), worktree: row.worktree };
  }
  putSession(session: ReviewSession, worktree: string) {
    const parsed = ReviewSession.parse(session);
    this.statements.putSession.run(parsed.id, worktree, JSON.stringify(parsed));
  }
  comment(sessionId: string, id: string): ReviewComment {
    const row = this.statements.comment.get(id, sessionId);
    if (!row) throw new Error("review_comment_not_found");
    return ReviewComment.parse(JSON.parse(String(row.data)));
  }
  insertComment(comment: ReviewComment) {
    if (Number(this.statements.countComments.get(comment.sessionId)?.n) >= 1000)
      throw new Error("review_comment_limit");
    this.putComment(comment);
  }
  putComment(comment: ReviewComment) {
    const parsed = ReviewComment.parse(comment);
    this.statements.putComment.run(parsed.id, parsed.sessionId, JSON.stringify(parsed));
  }
  reply(reply: ReviewReply) {
    const parsed = ReviewReply.parse(reply);
    if (Number(this.statements.countReplies.get(parsed.commentId)?.n) >= 100)
      throw new Error("review_reply_limit");
    this.statements.putReply.run(parsed.id, parsed.commentId, JSON.stringify(parsed));
  }
  allComments(sessionId: string): ReviewComment[] {
    return this.statements.comments
      .all(sessionId, "", 1000)
      .map((row) => ReviewComment.parse(JSON.parse(String(row.data))));
  }
  list(options: {
    sessionId?: string | undefined;
    commentId?: string | undefined;
    cursor: string;
    limit: number;
  }): ReviewData {
    if (options.commentId) {
      if (!options.sessionId) throw new Error("review_session_required");
      this.comment(options.sessionId, options.commentId);
      const replies = this.statements.replies
        .all(options.commentId, options.cursor, options.limit)
        .map((r) => ReviewReply.parse(JSON.parse(String(r.data))));
      return { replies, nextCursor: replies.at(-1)?.id ?? "" };
    }
    if (options.sessionId) {
      const { session } = this.session(options.sessionId);
      const comments = this.statements.comments
        .all(options.sessionId, options.cursor, options.limit)
        .map((r) => ReviewComment.parse(JSON.parse(String(r.data))));
      return { session, comments, nextCursor: comments.at(-1)?.id ?? "" };
    }
    const sessions = this.statements.sessions
      .all(options.cursor, options.limit)
      .map((r) => ReviewSession.parse(JSON.parse(String(r.data))));
    return { sessions, nextCursor: sessions.at(-1)?.id ?? "" };
  }
  begin(id: CommandId, device: string): CommandResult | undefined {
    const row = this.statements.receipt.get(id);
    if (row) {
      if (row.device !== device) throw new Error("review_receipt_device_mismatch");
      return row.result === null
        ? { commandId: id, ok: false, error: "review_recovery_required" }
        : CommandResult.parse(JSON.parse(String(row.result)));
    }
    this.statements.begin.run(id, device);
    return undefined;
  }
  finish(result: CommandResult) {
    this.statements.finish.run(JSON.stringify(CommandResult.parse(result)), result.commandId);
  }
}
