import { RequestStack } from "../composer/request-stack.tsx";
import { StripSurface } from "../composer/strip-surface.tsx";

/**
 * A provider subagent's open requests in the one strip above its status bar, as a thread shows
 * its own above the composer. Answering one resolves it for the agent that asked.
 */
export function SubagentRequests(props: { threadId: string; ids: readonly string[] }) {
  return (
    <StripSurface slot="request">
      <RequestStack threadId={props.threadId} ids={props.ids} onLeave={noop} />
    </StripSurface>
  );
}

const noop = () => {};
