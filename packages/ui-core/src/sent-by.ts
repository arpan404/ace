import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "./providers.ts";
import type { SystemInput } from "./system-input.ts";

/*
 * A message another thread's agent sent this one: a delegated task, a `thread_start` brief, a
 * follow-up through `agent_message`, or work from an agent on a paired machine. It shows as a sent
 * message with one line above it naming who sent it, linked to their thread when that is known.
 * Decoded leniently: what the origin doesn't say falls back to the thread's own facts, and what
 * neither says leaves "Sent from another thread" with no link. Pure.
 */

/** Who sent a message from another thread, as far as ace knows. */
export interface SentBy {
  /** The sending agent's provider, for its mark and name. */
  provider?: ProviderKind | undefined;
  /** The thread that sent it, on `host` when set, else on the machine holding this thread. */
  threadId?: string | undefined;
  /** The machine the sender is on, when that is another machine than this thread's. */
  host?: { id: string; name?: string | undefined } | undefined;
}

/** The thread facts that name a sender when a message's own origin doesn't. */
export interface SentByThread {
  delegatedBy?: string | undefined;
  startedBy?: string | undefined;
  delegatedFrom?:
    | {
        hostId: string;
        hostName?: string | undefined;
        threadId: string;
        provider?: ProviderKind | undefined;
      }
    | undefined;
}

const knownProviders = new Set<string>(Object.keys(providerNames));
const known = (provider: unknown): ProviderKind | undefined =>
  typeof provider === "string" && knownProviders.has(provider)
    ? (provider as ProviderKind)
    : undefined;

/**
 * Whether ace input is a message from another thread's agent. A portable handoff and an
 * automation's prompt keep their own labels.
 */
export function isSentByAgent(input: SystemInput): boolean {
  if (input.kind === "parent_agent") return true;
  return input.kind === "spawn" && !input.origin?.role?.startsWith("handoff: ");
}

/**
 * Who sent `input`, read from its origin first, then from `thread`. A message ace stamped with
 * no sender (history from before it was stamped) borrows the thread that started or delegated
 * this one; a provider's own agent message, with no origin at all, names no one.
 */
export function sentBy(input: SystemInput, thread?: SentByThread | undefined): SentBy | undefined {
  if (!isSentByAgent(input)) return undefined;
  const origin = input.origin;
  const provider = known(origin?.from?.provider);
  if (origin?.parentThreadId) return { provider, threadId: origin.parentThreadId };
  if (!origin) return {};
  const remote = thread?.delegatedFrom;
  if (remote)
    return {
      provider: provider ?? known(remote.provider),
      threadId: remote.threadId,
      host: { id: remote.hostId, name: remote.hostName },
    };
  const local = thread?.delegatedBy ?? thread?.startedBy;
  return local ? { provider, threadId: local } : { provider };
}

/**
 * The one line above the message: "Sent by Claude Code from another thread", "… from another
 * chat" when the sender is a chat, "… from another thread on Arpan's MacBook Pro" when it is on
 * another machine, and "Sent from another thread" when ace doesn't know whose agent it was.
 */
export function sentByLine(sent: SentBy, options?: { chat?: boolean | undefined }): string {
  const who = sent.provider ? `Sent by ${providerNames[sent.provider]}` : "Sent";
  const where = options?.chat ? "another chat" : "another thread";
  const host = sent.host?.name ? ` on ${sent.host.name}` : sent.host ? " on another machine" : "";
  return `${who} from ${where}${host}`;
}
