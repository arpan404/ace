import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * A long Settled history, opt-in with `ACE_IOS_SPIKE_SETTLED=N`: N finished threads the person
 * settled, more than one page, so the inbox has to show the daemon's total before the older
 * pages load. Settling goes through the daemon's own command path, as a client's would.
 */

type Details = (branch: string) => Record<string, unknown>;

export function seedSettled(daemon: FakeDaemon, details: Details, count: number) {
  for (let index = 0; index < count; index++) {
    const id = `ios-settled-${index}`;
    daemon.createThread({
      hasSentMessage: true,
      id,
      workspaceId: "ace",
      title: `Settled thread ${index + 1}`,
      provider: "codex",
      details: details(`settled/${index}`),
    });
    daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
    daemon.command({
      id: CommandId.parse(`ios-spike-settle-${index}`),
      deviceId: DeviceId.parse("ios-spike-seed"),
      payload: { type: "thread.settle", threadId: ThreadId.parse(id) },
    });
  }
}
