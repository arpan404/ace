import { facts, type FakeDaemon } from "@ace/fake-daemon";

/** A sent request whose agent has finished, so task tests don't seed an empty draft. */
export function createIdleTask(
  daemon: FakeDaemon,
  thread: Parameters<FakeDaemon["createThread"]>[0],
): void {
  daemon.createThread(thread);
  daemon.apply(thread.id, [
    facts.rootAgent(thread.provider),
    { type: "turn.started", agent: "root", nativeTurnId: "seeded-request", trigger: "user" },
    facts.message("root", "request", "user", thread.title),
    { type: "turn.ended", agent: "root", nativeTurnId: "seeded-request", outcome: "completed" },
  ]);
}
