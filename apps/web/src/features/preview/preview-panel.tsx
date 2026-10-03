import { BrowserIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";

/** Preview tab of the thread's right panel. TODO(preview slice): browser frame and controls. */
export function PreviewPanel(_props: { threadId: string }) {
  return (
    <EmptyState
      icon={BrowserIcon}
      title="Nothing to preview"
      description="When an agent starts a dev server, its page opens here."
    />
  );
}
