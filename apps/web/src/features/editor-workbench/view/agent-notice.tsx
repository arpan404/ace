import { Button } from "@/components/ui/button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import type { BufferFacts } from "./buffers.ts";

/**
 * Spec 46: the moment the disk version moves under unsaved edits, one line under the group's
 * breadcrumbs names who changed the file, with Merge and Compare. It stays until a merge or a
 * save clears the registry's clash; Merge waits while one runs.
 */
export function AgentNotice(props: { facts: BufferFacts; onMerge(): void; onCompare(): void }) {
  const { facts } = props;
  if (!facts.clash) return null;
  const changer = facts.changedBy;
  return (
    <div
      role="status"
      data-part="deck-notice"
      className="flex h-9 shrink-0 items-center gap-2 border-y border-border pr-2.5 pl-3.5 text-ui whitespace-nowrap text-foreground"
    >
      {changer?.provider && <ProviderIcon provider={changer.provider} size={14} decorative />}
      <span className="min-w-0 flex-1 truncate">
        {changer ? `${changer.name} also changed this file.` : "This file changed on disk."}
      </span>
      <Button size="sm" disabled={facts.clash.merging} onClick={props.onMerge}>
        Merge
      </Button>
      <Button size="sm" variant="ghost" onClick={props.onCompare}>
        Compare
      </Button>
    </div>
  );
}
