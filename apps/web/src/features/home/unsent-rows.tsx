import { StartedRows } from "./started-rows.tsx";
import { DraftRows } from "./new-thread/draft-rows.tsx";

/** Saved drafts and queued starts share one section after the admitted tasks. */
export function UnsentRows() {
  return (
    <div className="hidden has-[ul]:block">
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">Unsent</div>
      <DraftRows />
      <StartedRows />
    </div>
  );
}
