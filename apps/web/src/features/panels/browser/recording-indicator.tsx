import { useState } from "react";
import { useAgentLabel } from "@/components/agent-picker.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { BrowserView, PreviewSource } from "../sources.ts";

/**
 * Shown whenever the thread's browser is being recorded, by an agent or the person, with the
 * way to stop it (ADR 0067, privacy). The recording leaves agents' cursors and secret fields
 * out of its frames; the person still sees the page as it is.
 */
export function RecordingIndicator(props: {
  source: PreviewSource;
  threadId: string;
  view: BrowserView | undefined;
}) {
  const recording = props.view?.recording;
  const by = recording?.by;
  const agent = useAgentLabel(props.threadId, by?.kind === "agent" ? by.agentId : undefined);
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  if (!recording || !props.source.stopRecording) return null;
  const label = by?.kind === "agent" ? `${agent} is recording this tab` : "Recording this tab";
  const stop = () => {
    setStopping(true);
    props.source
      .stopRecording?.(props.threadId)
      .catch((error: unknown) =>
        toast.error({
          title: "Couldn't stop the recording",
          description: error instanceof Error ? error.message : undefined,
        }),
      )
      .finally(() => setStopping(false));
  };
  return (
    <div role="status" aria-label={label} className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
      <Button size="xs" variant="ghost" disabled={stopping} onClick={stop}>
        Stop recording
      </Button>
    </div>
  );
}
