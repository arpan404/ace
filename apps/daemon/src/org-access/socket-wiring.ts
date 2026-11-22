import { CommandId, ThreadId, type ServerMessage } from "@ace/protocol";
import { tree, unplaced } from "./decide.ts";
import { refusalMessage, socketGate } from "./gate.ts";
import type { PrincipalFacts } from "./principal.ts";
import { socketResource } from "./socket-operations.ts";
import type { TreeResolver } from "./trees.ts";

/*
 * The org host's access policy as `server.ts` uses it on each socket (ADR 0209 §4): thin glue
 * between the socket's own state and the pure `decide`. Every helper returns today's answer on
 * a person's machine.
 */

type Fail = (
  code: string,
  message: string,
  close?: boolean,
  scope?: { requestId?: string; subscriptionId?: string },
) => void;

/** The request or subscription a refusal answers, so the client can match it. */
function scopeOf(message: object): { requestId?: string; subscriptionId?: string } {
  const requestId = Reflect.get(message, "requestId");
  const subscriptionId = Reflect.get(message, "subscriptionId");
  return {
    ...(typeof requestId === "string" ? { requestId } : {}),
    ...(typeof subscriptionId === "string" ? { subscriptionId } : {}),
  };
}

/** The thread a notification is about, when it names one. */
function notificationThread(message: ServerMessage): ThreadId | undefined {
  if (message.type !== "notification") return undefined;
  const parsed = ThreadId.safeParse(Reflect.get(Object(message.notification), "threadId"));
  return parsed.success ? parsed.data : undefined;
}

export function orgSocketPolicy(deps: {
  org: () => string | undefined;
  facts: () => Omit<PrincipalFacts, "org">;
  trees: TreeResolver;
  fail: Fail;
  send: (message: ServerMessage) => void;
}) {
  const gate = socketGate(deps);
  const releases = new Map<string, () => void>();
  return {
    gate,
    personal: gate.personal,
    /**
     * Whether the socket speaks for anyone here at all: on an org host only a proven member or
     * the host's operator does. Every scope check a service makes includes it, so a standing
     * that lapses ends what those checks guard at their next check.
     */
    speaks(): boolean {
      if (gate.personal()) return true;
      const kind = gate.principal().kind;
      return kind === "member" || kind === "host";
    },
    /** Whether the socket may read `thread`'s tree, as services check it per read and event. */
    reads: (thread: ThreadId): boolean =>
      gate.personal() || gate.ask("tree.read", tree({ thread })).allowed,
    /** Refuses `message` when the policy does, answering its request: true when refused. */
    refuses(message: { type: string }): boolean {
      if (gate.personal()) return false;
      const decision = gate.message(message);
      if (decision.allowed) return false;
      const words = refusalMessage(decision.reason);
      // A refused command fails for good, named by its id, as the engine refuses one.
      const command = message.type === "command" ? Reflect.get(message, "command") : undefined;
      const commandId = CommandId.safeParse(Reflect.get(Object(command), "id"));
      if (commandId.success)
        deps.send({
          type: "error",
          code: "forbidden",
          message: words,
          commandId: commandId.data,
          retryable: false,
        });
      else deps.fail("forbidden", words, false, scopeOf(message));
      return true;
    },
    /**
     * Whether a hello may open `channel`. A member admission has proven nothing yet, so it
     * opens only the main channel, where every message is decided against what it proves.
     */
    opens(channel: string | undefined): boolean {
      return gate.personal() || gate.open(channel).allowed;
    },
    binary: (): boolean => gate.personal() || gate.binary().allowed,
    /** Notifications reach a socket only for trees it may read. */
    fanOut(send: (message: ServerMessage) => void): (message: ServerMessage) => void {
      return (message) => {
        if (gate.personal()) return send(message);
        const thread = notificationThread(message);
        if (thread !== undefined && gate.ask("tree.read", tree({ thread })).allowed) send(message);
      };
    },
    /** Binds a subscription the socket just made, and releases one it ended. */
    track(message: { type: string }, subscriptions: Map<string, () => void>): void {
      if (gate.personal()) return;
      if (message.type === "unsubscribe") {
        const id = String(Reflect.get(message, "subscriptionId"));
        releases.get(id)?.();
        releases.delete(id);
        return;
      }
      if (message.type !== "subscribe") return;
      const id = String(Reflect.get(message, "subscriptionId"));
      releases.get(id)?.();
      const resource = socketResource(message, "tree.read");
      releases.set(
        id,
        gate.handles.bind({
          operation: "tree.read",
          resource: resource.kind === "tree" ? resource : unplaced,
          close: (reason) => {
            subscriptions.get(id)?.();
            subscriptions.delete(id);
            releases.delete(id);
            deps.fail("access_lost", refusalMessage(reason), false, { subscriptionId: id });
          },
        }),
      );
    },
    /** Closes what the socket may no longer hold; a no-op on a person's machine. */
    revalidate(): void {
      if (!gate.personal()) gate.revalidate();
    },
  };
}
