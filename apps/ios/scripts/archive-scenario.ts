import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";

/*
 * The spike's archive and short snooze: 45 archived threads (three archive pages of twenty) and
 * `ios-nap`, a finished thread snoozed for `ACE_IOS_SPIKE_NAP_MS` (default 90 s). Take the
 * fixture offline (`POST /control {"online":false}`) before the snooze runs out to see the phone
 * end it on its own clock. No provider CLI runs.
 */

const projects = ["ace", "site", "docs"];

export function seedArchive(daemon: FakeDaemon, now: number, napMs: number): void {
  for (let index = 0; index < 45; index++) {
    const id = `ios-archived-${String(index).padStart(2, "0")}`;
    daemon.createThread({
      hasSentMessage: true,
      id,
      workspaceId: projects[index % projects.length] ?? "ace",
      title: `Archived task ${index + 1}`,
      provider: index % 2 ? "claude" : "codex",
    });
    daemon.apply(id, [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "m", "assistant", `Finished archived task ${index + 1}.`),
      facts.endTurn("root"),
    ]);
    daemon.updateThread(id, { archivedAt: now - (45 - index) * 60 * 60 * 1000 });
  }
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-nap",
    workspaceId: "ace",
    title: "Check the nightly build",
    provider: "codex",
  });
  daemon.apply("ios-nap", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "nap", "assistant", "The nightly build is green."),
    facts.endTurn("root"),
  ]);
  daemon.command({
    id: CommandId.parse("ios-spike-nap"),
    deviceId: DeviceId.parse("ios-spike-seed"),
    payload: { type: "thread.snooze", threadId: ThreadId.parse("ios-nap"), until: now + napMs },
  });
}
