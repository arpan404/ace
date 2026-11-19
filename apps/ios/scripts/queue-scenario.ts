import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";

/*
 * Threads whose queue is held or long, for the composer's strip, the queue sheet and the
 * transcript's message that wasn't sent. No provider process runs.
 * - ios-queue-long: a working thread with 40 follow-ups queued (the sheet lists 32, Show more),
 *   pursuing a goal, so its pills show the status, the queue and the goal together.
 * - ios-queue-paused: the person paused the queue with two waiting (Resume queue).
 * - ios-held-send: a session start failed: the message is kept as not sent, one more waits.
 * - ios-held-long: a not-sent message longer than the phone's 8,192-character preview.
 * - ios-limited: Codex ran out of usage with a known reset (Switch, Resume at reset, Continue).
 * - ios-stopped: the person stopped the turn (Continue).
 * - ios-resuming: out of usage, set to resume at reset ("Resumes at …", Switch or Cancel).
 * - ios-stopped-queued: the person stopped the turn with a message queued (Send now).
 * - ios-restart: a daemon restart cut the turn short (Continue).
 * - ios-left-running: the person stopped the turn while a dev server it started still runs (Stop).
 */

const minute = 60_000;
const device = DeviceId.parse("ios-spike-seed");

function queue(daemon: FakeDaemon, threadId: string, id: string, text: string): void {
  daemon.command({
    id: CommandId.parse(id),
    deviceId: device,
    payload: {
      type: "thread.send",
      threadId: ThreadId.parse(threadId),
      input: [{ type: "text", text }],
      delivery: "queue",
    },
  });
}

function thread(
  daemon: FakeDaemon,
  details: (branch: string) => Record<string, unknown>,
  id: string,
  title: string,
  ask: string,
  ended: boolean,
): void {
  daemon.createThread(
    {
      hasSentMessage: true,
      id,
      workspaceId: "ace",
      title,
      provider: "codex",
      details: details(`fix/${id}`),
    },
    30 * minute,
  );
  daemon.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", ask),
    facts.message("root", "answer", "assistant", "Working through it now."),
    ...(ended ? [facts.endTurn("root")] : []),
  ]);
}

export function seedQueues(
  daemon: FakeDaemon,
  details: (branch: string) => Record<string, unknown>,
): void {
  thread(
    daemon,
    details,
    "ios-queue-long",
    "Migrate every settings page",
    "Move the settings pages to the new form kit.",
    false,
  );
  for (let at = 1; at <= 40; at++)
    queue(
      daemon,
      "ios-queue-long",
      `ios-long-${at}`,
      `Then migrate settings page ${at} and check its tests`,
    );
  daemon.updateThread("ios-queue-long", {
    goal: {
      objective: "every settings page uses the form kit",
      status: "active",
      tokensUsed: 64_000,
      timeUsedSeconds: 900,
      checks: 1,
    },
  });

  thread(
    daemon,
    details,
    "ios-queue-paused",
    "Tidy the release script",
    "Make the release script idempotent.",
    false,
  );
  daemon.holdQueue("ios-queue-paused", "manual");
  queue(daemon, "ios-queue-paused", "ios-paused-1", "Then add a dry-run flag");
  queue(daemon, "ios-queue-paused", "ios-paused-2", "And document it in RELEASING.md");

  thread(
    daemon,
    details,
    "ios-held-send",
    "Wire the billing webhooks",
    "Add the Stripe webhook handler.",
    true,
  );
  daemon.holdQueue("ios-held-send", "not_sent", {
    title: "Codex couldn't start a session. The CLI exited with code 1.",
    code: "session_start_failed",
  });
  queue(
    daemon,
    "ios-held-send",
    "ios-held-1",
    "Now add retries with backoff to the webhook handler",
  );
  queue(daemon, "ios-held-send", "ios-held-2", "Then write the tests");
  daemon.apply("ios-held-send", [
    {
      type: "item.upsert",
      agent: "root",
      item: "held-notice",
      draft: {
        type: "notice",
        level: "warning",
        code: "input_queued",
        commandId: CommandId.parse("ios-held-1"),
        text: "Message kept",
        detail:
          "codex exec exited with code 1: error: unexpected argument '--sandbox-mode' found\n\nUsage: codex exec [OPTIONS] [PROMPT]",
        complete: true,
      },
    },
  ]);

  thread(
    daemon,
    details,
    "ios-held-long",
    "Rewrite the relay outbox",
    "Plan the outbox rewrite.",
    true,
  );
  daemon.holdQueue("ios-held-long", "not_sent", {
    title: "Codex couldn't start a session. The CLI exited with code 1.",
    code: "session_start_failed",
  });
  queue(
    daemon,
    "ios-held-long",
    "ios-held-long-1",
    `Rewrite the relay outbox: ${"keep every message in order and retry with backoff. ".repeat(220)}END-OF-MESSAGE`,
  );

  thread(
    daemon,
    details,
    "ios-limited",
    "Speed up the search index",
    "Profile the search indexer and fix the slow path.",
    false,
  );
  daemon.apply("ios-limited", [
    {
      type: "retry",
      agent: "root",
      on: "rate_limit",
      until: Date.now() + 2 * 60 * minute + 14 * minute,
      message: "You've hit your usage limit for this window.",
    },
  ]);

  thread(
    daemon,
    details,
    "ios-stopped",
    "Rename the user model",
    "Rename User to Account across the API.",
    true,
  );
  daemon.holdQueue("ios-stopped", "stopped");

  thread(
    daemon,
    details,
    "ios-resuming",
    "Backfill the audit log",
    "Backfill the audit log for last month.",
    false,
  );
  daemon.apply("ios-resuming", [
    {
      type: "retry",
      agent: "root",
      on: "rate_limit",
      until: Date.now() + 47 * minute,
      message: "You've hit your usage limit for this window.",
    },
  ]);
  // The queue's revision isn't known here: the first one the daemon takes is current.
  for (let revision = 0; revision < 8; revision++) {
    const result = daemon.command({
      id: CommandId.parse(`ios-resuming-at-reset-${revision}`),
      deviceId: device,
      payload: {
        type: "thread.limit",
        threadId: ThreadId.parse("ios-resuming"),
        expectedRevision: revision,
        action: "resume_at_reset",
      },
    });
    if (result.ok) break;
  }

  daemon.createThread(
    {
      hasSentMessage: true,
      id: "ios-left-running",
      workspaceId: "ace",
      title: "Start the relay for the phone",
      provider: "claude",
      details: details("fix/relay"),
    },
    12 * minute,
  );
  daemon.apply("ios-left-running", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Start the relay so I can test the phone."),
    facts.tool("root", "relay", {
      kind: "shell",
      title: "bun run dev:relay --port 8787",
      detail: { kind: "shell", command: "bun run dev:relay --port 8787" },
    }),
    {
      type: "background.started",
      agent: "root",
      task: "relay",
      kind: "shell",
      title: "bun run dev:relay --port 8787",
      item: "relay",
      stoppable: true,
    },
    facts.endTurn("root", "interrupted"),
  ]);

  // Queued while the turn runs, then the person stops it: the Stop keeps the message.
  thread(
    daemon,
    details,
    "ios-stopped-queued",
    "Split the settings page",
    "Split the settings page into tabs.",
    false,
  );
  queue(daemon, "ios-stopped-queued", "ios-stopped-queued-1", "Then add a search box to it");
  daemon.holdQueue("ios-stopped-queued", "stopped");
  daemon.apply("ios-stopped-queued", [facts.endTurn("root", "interrupted")]);

  thread(
    daemon,
    details,
    "ios-restart",
    "Migrate the sessions table",
    "Migrate the sessions table to the new schema.",
    true,
  );
  daemon.holdQueue("ios-restart", "restart");
}
