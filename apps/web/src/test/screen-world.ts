import type { FakeDaemon } from "@ace/fake-daemon";
import {
  ThreadId,
  ThreadView,
  type ScreenOperation,
  type ScreenServerMessage,
} from "@ace/protocol";

/**
 * The fake daemon's computer use, set up over its own screen wire the way an agent's tools and
 * the person's approvals would leave it: computer use on, apps approved and sessions held by a
 * thread's root agent. Tests then act through the app and read the daemon back.
 */
export function screenWorld(daemon: FakeDaemon, threadId: string) {
  const replies = new Map<string, Extract<ScreenServerMessage, { type: "screen.result" }>>();
  const connection = daemon.screen.connection((message) => {
    if (!(message instanceof Uint8Array) && message.type === "screen.result")
      replies.set(message.requestId, message);
  });
  let requests = 0;
  const call = async (operation: ScreenOperation): Promise<unknown> => {
    const requestId = `seed-${++requests}`;
    await connection.request({ type: "screen.request", requestId, operation });
    const reply = replies.get(requestId);
    if (!reply?.ok) throw new Error(reply?.error ?? "No screen reply");
    return reply.data;
  };
  const agentId = ThreadView.parse(
    daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) }),
  ).thread.rootAgentId;
  if (!agentId) throw new Error(`Thread ${threadId} has no root agent`);
  const holder = { threadId, agentId };
  return {
    call,
    holder,
    /** Live sessions as the daemon holds them. */
    async sessions() {
      return (await call({ op: "sessions" })) as {
        sessionId: string;
        controller: string;
        mode: string;
      }[];
    },
    /** Computer use on and `bundleId` approved always, held by the thread's root agent. */
    async agentApp(bundleId: string): Promise<string> {
      await call({ op: "enable", enabled: true });
      await call({ op: "approve", bundleId, allowed: true, scope: "always" });
      const started = (await call({ op: "start", target: { kind: "app", bundleId }, fps: 10 })) as {
        sessionId: string;
      };
      await call({
        op: "controller",
        sessionId: started.sessionId,
        controller: "agent",
        ...holder,
      });
      return started.sessionId;
    },
  };
}
