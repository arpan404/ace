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
  private publications = new Map<string, ForgePrStatus>();
  /** Threads whose PR merges as soon as its checks pass (`forge.pr.auto-merge`). */
  private autoMerge = new Set<string>();
  constructor(context: FakeServiceContext) {
    this.context = context;
  }
  status(id: string): ForgePrStatus | null {
    return [...this.links].findLast(([key]) => key.startsWith(`${id}:`))?.[1] ?? null;
  }
  /** Link a pull request the forge already knows: its checks, comments and state. */
  seed(threadId: string, status: ForgePrStatus): void {
    if (!this.context.thread(threadId)) throw new Error(`No thread ${threadId} to link`);
    this.sequence = Math.max(this.sequence, status.ref.number);
    const next = ForgePrStatus.parse(status);
    // As GitHub does, a PR with auto-merge on merges once its checks pass.
    this.publish(threadId, this.autoMerge.has(threadId) && ready(next) ? merged(next) : next);
  }
  private publish(id: string, status: ForgePrStatus): void {
    this.links.set(linkKey(id, status.ref), status);
    for (const [key, known] of this.publications)
      if (
        known.ref.number === status.ref.number &&
        JSON.stringify(known.ref.repository) === JSON.stringify(status.ref.repository)
      )
        this.publications.set(key, status);
    const details = this.context.thread(id)?.thread.details;
    if (details?.branch && this.publications.size < 64)
      this.publications.set(
        JSON.stringify({
          repository: status.ref.repository,
          branch: details.branch,
          base: details.base?.ref ?? details.baseBranch ?? "main",
        }),
        status,
      );
    const thread = this.context.thread(id)?.thread;
    if (thread && status.state !== "unknown")
      this.context.update(id, {
        type: "thread.client.updated",
        changes: {
          details: {
            ...thread.details,
            linkedPrs: [...this.links]
              .filter(([key]) => key.startsWith(`${id}:`))
              .map(([, pr]) => ({
                number: pr.ref.number,
                repo: pr.ref.repository,
                url: pr.url,
                state: pr.state === "unknown" ? "open" : pr.state,
                title: pr.title,
                updatedAt: this.context.now(),
              }))
              .toReversed(),
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
    if (p.type === "forge.pr.unlink") {
      for (const [key, status] of this.links)
        if (
          key.startsWith(`${id}:`) &&
          (p.all ||
            (status.ref.number === p.number &&
              (!p.repo || JSON.stringify(p.repo) === JSON.stringify(status.ref.repository))))
        )
          this.links.delete(key);
      this.autoMerge.delete(id);
      const thread = this.context.thread(id)?.thread;
      this.context.update(id, {
        type: "thread.client.updated",
        changes: {
          details: {
            ...thread?.details,
            linkedPrs:
              thread?.details?.linkedPrs?.filter(
                (pr) =>
                  !p.all &&
                  (pr.number !== p.number ||
                    (p.repo && JSON.stringify(pr.repo) !== JSON.stringify(p.repo))),
              ) ?? [],
            linkedPr: this.status(id)
              ? { number: this.status(id)?.ref.number ?? 0, state: "open" }
              : null,
          },
        },
      });
      return { ok: true };
    }
    if (this.links.size >= 64) return { ok: false, error: "forge_limit" };
    const repository = "repository" in p ? p.repository : p.link.pr.repository;
    if (repository.forge !== "github") return { ok: false, error: "forge_unsupported" };
    if (p.type === "forge.pr.create") {
      const key = JSON.stringify({
        repository: p.repository,
        branch: p.input.branch,
        base: p.input.base,
      });
      const existing = this.publications.get(key);
      if (existing) {
        this.publish(id, existing);
        return { ok: true, pr: existing.ref, prStatus: existing };
      }
      if (this.publications.size >= 64) return { ok: false, error: "forge_limit" };
      const pr = { repository: p.repository, number: ++this.sequence };
      const status = this.open(id, pr, p.input.title, p.input.draft);
      this.publications.set(key, status);
      this.publish(id, status);
      return { ok: true, pr, prStatus: this.status(id) ?? undefined };
    }
    if (p.type === "forge.pr.link") {
      const status =
        [...this.links.values()].find(
          (known) =>
            known.ref.number === p.link.pr.number &&
            JSON.stringify(known.ref.repository) === JSON.stringify(p.link.pr.repository),
        ) ?? this.open(id, p.link.pr, this.context.thread(id)?.thread.title ?? "PR");
      this.publish(id, status);
      return { ok: true, pr: p.link.pr, prStatus: status };
    }
    const status = this.links.get(linkKey(id, p.link.pr));
    if (
      !status ||
      status.ref.number !== p.link.pr.number ||
      JSON.stringify(status.ref.repository) !== JSON.stringify(p.link.pr.repository)
    )
      return { ok: false, error: "forge_not_found" };
    if (p.type === "forge.pr.status") return { ok: true, prStatus: status };
    if (p.type === "forge.pr.merge" || p.type === "forge.pr.auto-merge") {
      if (p.headSha !== status.headSha) return { ok: false, error: "forge_conflict" };
      if (p.type === "forge.pr.merge" || ready(status))
        this.publish(ThreadId.parse(id), merged(status));
      else this.autoMerge.add(id);
    }
    if (p.type === "forge.comment.reply") {
      if (status.comments.length >= 64) return { ok: false, error: "forge_limit" };
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
    return { ok: true, pr: status.ref, prStatus: this.status(id) ?? undefined };
  }
}

const ready = (status: ForgePrStatus) =>
  status.state === "open" && status.ci === "success" && status.mergeability === "mergeable";
const merged = (status: ForgePrStatus): ForgePrStatus => ({ ...status, state: "merged" });

const linkKey = (id: string, ref: ForgePrRef) => `${id}:${JSON.stringify(ref)}`;
