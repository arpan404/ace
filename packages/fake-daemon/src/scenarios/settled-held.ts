import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import type { FakeDaemon } from "../daemon.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

const day = 24 * 60 * 60_000;

/**
 * Settled threads that leaked back into the Inbox before the daemon placed them (ADR 0107,
 * "Placement on the daemon"): days-old ones held at a usage limit or a rate limit, or with only
 * a command left running, stay in Settled.
 */
export function seedSettledHeld(daemon: FakeDaemon, now: number): void {
  const seed = (id: string, title: string, agoMs: number) => {
    daemon.createThread(
      { id, workspaceId: "ace", title, provider: "codex", hasSentMessage: true },
      agoMs,
    );
    daemon.apply(
      id,
      [rootAgent("codex"), turn("root"), message("root", "ask", "user", title), endTurn("root")],
      agoMs,
    );
    daemon.command({
      id: CommandId.parse(`settle-${id}`),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.settle", threadId: ThreadId.parse(id) },
    });
  };
  seed("thread-held-limit", "Migrate the billing exports", 4 * day);
  daemon.updateThread(
    "thread-held-limit",
    { status: { state: "limited", until: now + day } },
    4 * day,
  );
  seed("thread-held-rate", "Backfill the audit log", 3 * day);
  daemon.updateThread(
    "thread-held-rate",
    { status: { state: "waiting", on: "rate_limit" } },
    3 * day,
  );
  seed("thread-held-server", "Preview the pricing page", 2 * day);
  daemon.updateThread(
    "thread-held-server",
    { status: { state: "waiting", on: "background_task" } },
    2 * day,
  );
}
