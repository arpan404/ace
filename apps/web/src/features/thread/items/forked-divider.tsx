import { GitForkIcon } from "@phosphor-icons/react";
import { ThreadLink } from "../transitions/thread-link.tsx";
import { CentredDivider } from "./centred-divider.tsx";

/**
 * Where a fork's copy of the conversation it continues ends and its own work begins:
 * "⑂ Forked from <source title>", the title a link to that thread under its current name.
 */
export function ForkedDivider(props: { sourceThreadId: string }) {
  return (
    <CentredDivider icon={<GitForkIcon aria-hidden size={12} className="shrink-0" />}>
      <span className="font-medium">Forked from</span>
      <span className="min-w-0 max-w-[40ch] truncate">
        <ThreadLink threadId={props.sourceThreadId} fallback="the earlier thread" />
      </span>
    </CentredDivider>
  );
}
