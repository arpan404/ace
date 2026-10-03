import {
  ForgeCommand,
  ForgePrStatus,
  ThreadId,
  type CommandPayload,
  type CommandResult,
  type ForgePrRef,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";
/** Scripted forge state uses the canonical contract, including optimistic merge guards. */
export class FakeForgeWire {
  private context: FakeServiceContext;
  private links = new Map<string, ForgePrStatus>();
  private sequence = 0;
  constructor(context: FakeServiceContext) {
    this.context = context;
  }
  status(id: string): ForgePrStatus | null {
    return this.links.get(id) ?? null;
  }
  /** Link a pull request the forge already knows: its checks, comments and state. */
  seed(threadId: string, status: ForgePrStatus): void {
    if (!this.context.thread(threadId)) throw new Error(`No thread ${threadId} to link`);
    this.publish(threadId, ForgePrStatus.parse(status));
  }
  private publish(id: string, status: ForgePrStatus): void {
    this.links.set(id, status);
    const thread = this.context.thread(id)?.thread;
    if (thread && status.state !== "unknown")
      this.context.update(id, {
        type: "thread.client.updated",
        changes: {
          details: {
            ...thread.details,
            linkedPr: {
              number: status.ref.number,
              state: status.state === "draft" ? "open" : status.state,
              url: status.url,
            },
          },
        },
      });
  }
  private open(id: string, ref: ForgePrRef, title: string, draft = false): ForgePrStatus {
    const thread = this.context.thread(id)?.thread;
    return ForgePrStatus.parse({
      ref,
      title,
      url: `https://${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}/pull/${ref.number}`,
      headSha: thread?.details?.head ?? "a".repeat(40),
      state: draft ? "draft" : "open",
      mergeability: "mergeable",
      ci: "none",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
    });
  }
  command(payload: CommandPayload): Omit<CommandResult, "commandId"> | undefined {
    const parsed = ForgeCommand.safeParse(payload);
    if (!parsed.success) return undefined;
    const p = parsed.data;
    const id = "threadId" in p ? p.threadId : p.link.threadId;
    if (!this.context.thread(id)) return { ok: false, error: "thread_not_found" };
    if (!this.links.has(id) && this.links.size >= 64) return { ok: false, error: "forge_limit" };
    if (p.type === "forge.pr.create") {
      const pr = { repository: p.repository, number: ++this.sequence };
      this.publish(id, this.open(id, pr, p.input.title, p.input.draft));
      return { ok: true, pr };
    }
    if (p.type === "forge.pr.link") {
      const status = this.open(id, p.link.pr, this.context.thread(id)?.thread.title ?? "PR");
      this.publish(id, status);
      return { ok: true, pr: p.link.pr, prStatus: status };
    }
    const status = this.links.get(id);
    if (
      !status ||
      status.ref.number !== p.link.pr.number ||
      JSON.stringify(status.ref.repository) !== JSON.stringify(p.link.pr.repository)
    )
      return { ok: false, error: "pr_not_found" };
    if (p.type === "forge.pr.status") return { ok: true, prStatus: status };
    if (p.type === "forge.pr.merge" || p.type === "forge.pr.auto-merge") {
      if (p.headSha !== status.headSha) return { ok: false, error: "head_changed" };
      if (p.type === "forge.pr.merge")
        this.publish(ThreadId.parse(id), { ...status, state: "merged" });
    }
    if (p.type === "forge.comment.reply") {
      if (status.comments.length >= 64) return { ok: false, error: "comment_limit" };
      this.publish(id, {
        ...status,
        comments: [
          ...status.comments,
          {
            kind: "issue",
            id: status.comments.length + 1,
            body: p.body,
            author: "person",
            file: null,
            line: null,
            updatedAt: new Date(this.context.now()).toISOString(),
            replyTo: p.commentId,
          },
        ],
      });
    }
    return { ok: true };
  }
}
