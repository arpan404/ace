import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { chats, ScenarioPlayer, type FakeDaemon } from "@ace/fake-daemon";

/*
 * Chats for the Chats tab (ADR 0099): the shared fixture's chats across the days, one still
 * working and one just finished, the older ones settled so they fall under Yesterday, Previous
 * 7 days and Earlier. No provider process runs.
 */
export function seedChats(daemon: FakeDaemon): void {
  for (const [index, { scenario, agoMs }] of chats().entries()) {
    new ScenarioPlayer(daemon, scenario, { agoMs }).runUntilBlocked();
    // The two newest stay Active; the rest are settled, as a day's chats are once read.
    if (index < 2) continue;
    daemon.command({
      id: CommandId.parse(`ios-chat-settle-${index}`),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.settle", threadId: ThreadId.parse(scenario.thread.id) },
    });
  }
}
