import { useThreadMeta } from "@ace/client-react";
import { InfoIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { failure } from "./use-git-flow.tsx";
import { RowAction, RowLabel, RowStatic } from "./work-card-parts.tsx";

/**
 * The setup script of a worktree made when the thread first ran, in the Work card: a failure
 * with its output, Retry and Continue (both let the held first message go); or a note that it
 * didn't run because the thread is Read-only.
 */
export function WorktreeSetupRow(props: { thread: ThreadRef }) {
  const setup = useThreadMeta(props.thread.id)?.details?.worktreeSetup;
  const sources = useThreadSources();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!setup) return null;
  if (setup.state === "skipped")
    return (
      <RowStatic label="Setup skipped: this thread is Read-only">
        <InfoIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
        <RowLabel>Setup skipped: Read-only</RowLabel>
      </RowStatic>
    );
  const choose = (action: "retry" | "continue") => {
    setBusy(true);
    void sources.workspace
      .resolveSetup(props.thread, action)
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't start the thread", description: failure(error) }),
      )
      .finally(() => setBusy(false));
  };
  const output = setup.details.join("\n");
  return (
    <>
      <RowStatic label="Setup script failed" className="flex-wrap">
        <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <RowLabel>Setup script failed</RowLabel>
        <RowAction className="ml-0" disabled={busy} onClick={() => choose("retry")}>
          Retry
        </RowAction>
        <RowAction className="ml-0" disabled={busy} onClick={() => choose("continue")}>
          Continue without setup
        </RowAction>
      </RowStatic>
      {output && (
        <pre
          role="log"
          aria-label="Setup output"
          className="max-h-40 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
        >
          {output}
        </pre>
      )}
    </>
  );
}
