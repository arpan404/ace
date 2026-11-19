import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * Rows that are easy to open by mistake, for the routing UI tests (`RoutingUITests`): a thread
 * whose id every fixture machine shares, titled and worded for its own machine, and a chat and a
 * project thread with one title. The project threads are pinned, so they lead the list on every
 * machine however many other threads it holds. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;

export function seedRouting(daemon: FakeDaemon, details: Details, machineName: string): void {
  thread(daemon, "ios-routing-twin", `Twin on ${machineName}`, `Answer from ${machineName}.`, {
    workspaceId: "ace",
    details: details("routing/twin"),
  });
  thread(daemon, "ios-routing-thread", "Plan the launch", "Project plan, as a thread.", {
    workspaceId: "ace",
    details: details("routing/launch"),
  });
  thread(daemon, "ios-routing-chat", "Plan the launch", "Launch ideas, as a chat.", {
    workspaceId: "chat-ios-routing",
    details: {
      workspace: { id: "chat-ios-routing", name: "Chat", path: "/c/ios-routing", kind: "chat" },
      mode: "local",
    },
  });
  for (const id of ["ios-routing-twin", "ios-routing-thread"])
    daemon.command({
      id: CommandId.parse(`ios-routing-pin-${id}`),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.pin", threadId: ThreadId.parse(id), pinned: true },
    });
}

function thread(
  daemon: FakeDaemon,
  id: string,
  title: string,
  answer: string,
  place: { workspaceId: string; details: Record<string, unknown> },
) {
  daemon.createThread({ hasSentMessage: true, id, title, provider: "claude", ...place });
  daemon.apply(id, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", `${id}-answer`, "assistant", answer),
    facts.endTurn("root"),
  ]);
}
