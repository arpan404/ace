import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * A busy machine for inbox performance runs, opt-in with `ACE_IOS_SPIKE_INBOX=N`: N more threads,
 * and every `ACE_IOS_SPIKE_INBOX_MS` (200 by default) one of them starts or ends a turn, so the
 * inbox keeps regrouping rows the way many working agents make it. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;

export function busyInbox(daemon: FakeDaemon, details: Details, count: number, everyMs: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = `ios-busy-${index}`;
    ids.push(id);
    daemon.createThread({
      hasSentMessage: true,
      id,
      workspaceId: "ace",
      title: `Busy thread ${index + 1}: tidy module ${index % 37}`,
      provider: index % 3 === 0 ? "claude" : "codex",
      details: details(`busy/${index}`),
    });
    daemon.apply(id, [
      facts.rootAgent(index % 3 === 0 ? "claude" : "codex"),
      facts.turn("root"),
      facts.endTurn("root"),
    ]);
  }
  /** The turn each working thread is in; each new turn has its own id. */
  const working = new Map<string, string>();
  let tick = 0;
  return setInterval(() => {
    const id = ids[(tick++ * 7) % ids.length];
    if (id === undefined) return;
    const turn = working.get(id);
    if (turn) {
      working.delete(id);
      daemon.apply(id, [
        { type: "turn.ended", agent: "root", nativeTurnId: turn, outcome: "completed" },
      ]);
    } else {
      const next = `busy-turn-${tick}`;
      working.set(id, next);
      daemon.apply(id, [
        { type: "turn.started", agent: "root", nativeTurnId: next, trigger: "user" },
      ]);
    }
  }, everyMs);
}
