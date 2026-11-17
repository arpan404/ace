import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { z } from "zod";

/*
 * Fresh threads for the read-mark tests (#2183): a finished thread with one uncommitted file, so
 * the phone has its Changes page, and answers that arrive on request. The fixture keeps each
 * `thread.markRead` the phone sends, so a test can ask how far a thread was read. No provider
 * process runs.
 */

type Details = Parameters<FakeDaemon["createThread"]>[0]["details"];

const path = "apps/server/src/replay/window.ts";
const before = "export const ReplayLimit = 100;\n";
const after = "export const ReplayLimit = 200;\n";
const diff = [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1 +1 @@",
  `-${before.trimEnd()}`,
  `+${after.trimEnd()}`,
  "",
].join("\n");

const MarkRead = z.object({
  type: z.literal("command"),
  command: z.object({
    payload: z.object({
      type: z.literal("thread.markRead"),
      threadId: z.string(),
      lastSeenSeq: z.number(),
    }),
  }),
});
const Thread = z.object({ threadId: z.string().min(1).max(64) });

export class ReadMarkScenario {
  readonly #daemon: FakeDaemon;
  readonly #details: (branch: string) => NonNullable<Details>;
  /** Each thread's read marks, in the order the phone sent them. */
  readonly #marks = new Map<string, number[]>();
  #threads = 0;
  #answers = 0;

  constructor(daemon: FakeDaemon, details: (branch: string) => NonNullable<Details>) {
    this.#daemon = daemon;
    this.#details = details;
  }

  /** Keeps a `thread.markRead` the phone sent. */
  observe(data: string): void {
    if (!data.includes('"thread.markRead"')) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = MarkRead.safeParse(message);
    if (!parsed.success) return;
    const { threadId, lastSeenSeq } = parsed.data.command.payload;
    this.#marks.set(threadId, [...(this.#marks.get(threadId) ?? []), lastSeenSeq]);
  }

  /** `/review/read-mark/*`, or undefined for any other request. */
  async control(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/review/read-mark/thread" && request.method === "POST")
      return Response.json({ threadId: this.#seed() });
    if (url.pathname === "/review/read-mark/answer" && request.method === "POST") {
      this.#answer(Thread.parse(await request.json()).threadId);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/review/read-mark/marks")
      return Response.json({ marks: this.#marks.get(url.searchParams.get("thread") ?? "") ?? [] });
    return undefined;
  }

  #seed(): string {
    const threadId = `ios-read-${++this.#threads}`;
    this.#daemon.createThread({
      hasSentMessage: true,
      id: threadId,
      workspaceId: "ace",
      title: "Raise the replay limit",
      provider: "codex",
      details: this.#details("feat/replay-limit"),
    });
    this.#daemon.apply(threadId, [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "Raise the replay limit to 200."),
      facts.message("root", "answer", "assistant", "The replay limit is 200 now."),
      facts.endTurn("root"),
    ]);
    this.#daemon.workspace.setDetails(threadId, {
      worktree: `/tmp/ace-ios-spike/worktrees/${threadId}`,
      head: "6".repeat(40),
      ahead: 0,
      behind: 0,
      diff: { files: 1, additions: 1, deletions: 1 },
      repository: { forge: "github", host: "github.com", owner: "arpan404", name: "ace" },
    });
    // After its details: a checkout is found by the thread's own worktree.
    this.#daemon.checkouts.seed(threadId, path, after);
    this.#daemon.workspace.setGitStatus(threadId, [
      { path, status: "modified", additions: 1, deletions: 1, binary: false },
    ]);
    this.#daemon.workspace.setGitDiff(threadId, diff);
    return threadId;
  }

  /** Another finished turn with an answer on `threadId`. */
  #answer(threadId: string): void {
    const n = ++this.#answers;
    this.#daemon.apply(threadId, [
      facts.turn("root"),
      facts.message("root", `ask-${n}`, "user", `Check the limit again (${n}).`),
      facts.message("root", `answer-${n}`, "assistant", `Still 200 (${n}).`),
      facts.endTurn("root"),
    ]);
  }
}
