import type { Fact } from "@ace/core";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { AgentId, ItemId, RunId, ThreadId } from "@ace/protocol";

/*
 * Forked threads for the spike daemon: one forked from "ios-done", whose "Forked from" divider
 * opens it, and one whose source is gone, whose divider names it in plain words. Each carries
 * the source's copied history, then its own ask and answer.
 */

type Details = (branch: string) => Record<string, unknown>;

/** A message copied from the source when the fork was made. */
const copied = (source: string, key: string, role: "user" | "assistant", text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item: key,
  draft: {
    type: "message",
    role,
    complete: true,
    parts: [{ type: "text", text }],
    inherited: { threadId: ThreadId.parse(source), itemId: ItemId.parse(`${source}-${key}`) },
  },
});

/** The fork's own first message, as the person sent it. */
const ask = (text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item: "own-ask",
  draft: {
    type: "message",
    role: "user",
    complete: true,
    origin: { kind: "person" },
    parts: [{ type: "text", text }],
  },
});

function seedFork(
  daemon: FakeDaemon,
  details: Details,
  fork: { id: string; source: string; title: string },
) {
  daemon.createThread({
    hasSentMessage: true,
    id: fork.id,
    workspaceId: "ace",
    title: fork.title,
    provider: "codex",
    details: details("main"),
    lineage: {
      parentThreadId: ThreadId.parse(fork.source),
      parentAgentId: AgentId.parse(`${fork.source}.root`),
      point: { type: "turn", runId: RunId.parse(`${fork.source}.run.1`) },
      mode: "portable",
      lossy: true,
    },
  });
  daemon.apply(fork.id, [
    facts.rootAgent("codex"),
    copied(fork.source, "ask", "user", "Tighten the composer spacing."),
    copied(
      fork.source,
      "answer",
      "assistant",
      "The composer respects Dynamic Type and the keyboard safe area.",
    ),
    facts.turn("root"),
    ask("Now do the same for the inbox search field."),
    facts.message("root", "own-answer", "assistant", "The search field now uses the same insets."),
    facts.endTurn("root"),
  ]);
}

export function seedForks(daemon: FakeDaemon, details: Details): void {
  seedFork(daemon, details, {
    id: "ios-fork",
    source: "ios-done",
    title: "Tighten the search field spacing",
  });
  seedFork(daemon, details, {
    id: "ios-fork-gone",
    source: "ios-deleted",
    title: "Spacing follow-up",
  });
}
