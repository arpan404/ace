import { useThreadError, useThreadMeta } from "@ace/client-react";
import { PanelRightIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";
import { StatusPill } from "@/components/status-pill.tsx";
import { AgentPanel } from "@/features/agents/agent-panel.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { threadStatusLabel } from "@/lib/status.ts";
import { Transcript } from "./transcript.tsx";

/** Thread main view plus the collapsible agent panel (inline at lg, a sheet below). */
export function ThreadView(props: {
  threadId: string;
  panelOpen: boolean;
  onPanelChange(open: boolean): void;
}) {
  const thread = useThreadMeta(props.threadId);
  const error = useThreadError(props.threadId);
  const wide = useMediaQuery("(min-width: 64rem)", true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const toggle = () => (wide ? props.onPanelChange(!props.panelOpen) : setSheetOpen(!sheetOpen));
  useHotkey("mod+.", toggle);
  const status = thread ? threadStatusLabel(thread.status) : undefined;
  return (
    <div className="flex h-full min-h-0">
      <section aria-labelledby="thread-title" className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
          <h1 id="thread-title" className="min-w-0 flex-1 truncate text-sm font-medium">
            {thread?.title ?? "Loading thread…"}
          </h1>
          {status && <StatusPill tone={status.tone} label={status.label} />}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Agents panel"
            aria-pressed={wide ? props.panelOpen : sheetOpen}
            onClick={toggle}
          >
            <PanelRightIcon />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="p-4 text-sm text-status-failed">
            This thread could not be loaded ({error.message}).
          </p>
        ) : (
          <div className="min-h-0 flex-1">
            <Transcript threadId={props.threadId} />
          </div>
        )}
      </section>
      {wide && props.panelOpen && (
        <aside aria-label="Agents" className="w-72 shrink-0 overflow-y-auto border-l">
          <AgentPanel threadId={props.threadId} />
        </aside>
      )}
      {!wide && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="w-80 p-0">
            <SheetTitle className="sr-only">Agents</SheetTitle>
            <AgentPanel threadId={props.threadId} />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
