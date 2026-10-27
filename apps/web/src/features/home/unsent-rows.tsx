import { StartedRows } from "./started-rows.tsx";
import { DraftRows } from "./new-thread/draft-rows.tsx";
import { ForkDraftRows } from "./fork-draft-rows.tsx";
import { useSidebarDevice } from "./device-filter-state.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";

/** Saved drafts, unsent forks and queued starts share one section at the top of the list. */
export function UnsentRows() {
  const device = useSidebarDevice();
  const own = usePrimaryMachine().id;
  const showOwn = !device || device === own;
  return (
    <div className="hidden has-[ul]:block">
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
        Unsent
      </div>
      <DraftRows />
      {showOwn && <ForkDraftRows />}
      {showOwn && <StartedRows />}
    </div>
  );
}
