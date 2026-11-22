import { decide, unplaced, type Decision, type Operation, type Resource } from "./decide.ts";
import { Handles, holderKey } from "./handles.ts";
import { principal, type Principal, type PrincipalFacts } from "./principal.ts";
import { channelOperation, socketOperation, socketResource } from "./socket-operations.ts";
import type { TreeResolver } from "./trees.ts";

/*
 * The policy as one socket asks it (ADR 0209 §4.2): its principal recomputed from what the
 * socket proved at the moment of asking, every message and binary frame decided before any
 * service sees it, and its live handles closed once it loses what they were allowed for.
 */

/** What a refusal says to the client. */
export const refusalWords: Readonly<Record<string, string>> = {
  unproven: "Prove you're a member of this organization on this connection first.",
  operator: "This host's own token runs the daemon; it doesn't read members' work.",
  not_org_owner: "Only an owner of this organization, proven on this connection, can do that.",
  unclassified: "This organization's host doesn't allow that.",
  refused_on_org_host: "This organization's host doesn't allow that.",
  unplaced: "That isn't shared with you on this host.",
  not_shared: "That isn't shared with you on this host.",
  not_owner: "Only this thread's owner can do that.",
  other_child: "That capability is for another child.",
};

export function refusalMessage(reason: string): string {
  return refusalWords[reason] ?? "This organization's host doesn't allow that.";
}

export type SocketGate = ReturnType<typeof socketGate>;

export function socketGate(deps: {
  /** The organization that owns this machine, read fresh each time. */
  org: () => string | undefined;
  /** What the socket has proved so far. */
  facts: () => Omit<PrincipalFacts, "org">;
  trees: TreeResolver;
}) {
  const handles = new Handles();
  const current = (): Principal => principal({ org: deps.org(), ...deps.facts() });
  const ask = (operation: Operation | undefined, resource: Resource): Decision =>
    decide(current(), operation, resource, deps.trees);
  /** The channel this socket opened, and so what its binary frames are. */
  let channel: Operation | undefined = "session";
  return {
    principal: current,
    /** Whether the policy steps aside here: a person's machine. */
    personal: () => deps.org() === undefined,
    message(message: { type: string }): Decision {
      const operation = socketOperation(message);
      return ask(operation, operation ? socketResource(message, operation) : unplaced);
    },
    /** Opening a dedicated channel; its binary frames are decided as this opening was. */
    open(name: string | undefined): Decision {
      channel = channelOperation(name);
      return ask(channel, unplaced);
    },
    /**
     * A binary frame: taken only on a channel whose opening `decide` still allows. The main
     * channel carries none on an org host.
     */
    binary(): Decision {
      return ask(channel === "session" ? undefined : channel, unplaced);
    },
    ask,
    handles,
    /** Closes every live handle the socket's current principal may no longer hold. */
    revalidate: () => handles.revalidate(ask, holderKey(current())),
    /** The current principal's key, which a bound handle must still match. */
    holder: () => holderKey(current()),
  };
}
