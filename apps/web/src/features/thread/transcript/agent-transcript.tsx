import type { ReactNode } from "react";
import { ThreadNavProvider } from "../long/nav.tsx";
import { Transcript } from "./transcript.tsx";

/**
 * A provider subagent's transcript, as its whole chat: the thread's transcript over this
 * subagent's lane (ADR 0062), held so siblings streaming into the shared tail never trim it.
 */
export function AgentTranscript(props: {
  threadId: string;
  agentId: string;
  prompt?: ReactNode;
  live?: ReactNode;
}) {
  return (
    <ThreadNavProvider threadId={props.threadId} agentId={props.agentId}>
      <Transcript threadId={props.threadId} lane={props} />
    </ThreadNavProvider>
  );
}
