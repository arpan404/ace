import { useState, type ReactNode } from "react";
import { formatElapsed, type MergeMethod } from "@ace/ui-core";
import type { VerifyRun } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { useSeconds } from "@/lib/time.ts";
import { useVerifyLog } from "@/lib/verify.ts";
import { PrCheckLog } from "@/features/forge/index.ts";
import type { MergeRun } from "./merge-run.ts";
import { pullRequests, runWords, type StripAction } from "./merge-run-words.ts";

const methods: { value: MergeMethod; label: string }[] = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase" },
];

function Dot() {
  return (
    <span aria-hidden className="text-subtle-foreground">
      ·
    </span>
  );
}

/** A strip's text action: flat, the first one in the foreground. */
function Action(props: {
  lead?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={props.disabled}
      onClick={props.onClick}
      className={props.lead ? "text-foreground" : undefined}
    >
      {props.children}
    </Button>
  );
}

function Elapsed(props: { since: number }) {
  const now = useSeconds(true);
  return (
    <span className="text-subtle-foreground tabular-nums">{formatElapsed(now - props.since)}</span>
  );
}

function RunLog(props: { run: VerifyRun; open: boolean; onOpenChange(open: boolean): void }) {
  const log = useVerifyLog(props.open ? props.run : undefined);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="w-[min(56rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>{`Log of ${props.run.command}`}</DialogTitle>
        </DialogHeader>
        {log.data ? (
          <PrCheckLog log={log.data} name={props.run.command} />
        ) : (
          <p className="text-ui text-muted-foreground">
            {log.isError ? "Couldn't read the log." : "Reading the log…"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The list's merge strip: one sentence and text actions under the toolbar, pinned with it.
 * Picking ready rows reads "Verify and merge 3 pull requests into main · Squash ⌄ · Start ·
 * Clear"; a run then reads its progress with its time and Stop, and settles into its ending.
 */
export function MergeStrip(props: {
  merge: MergeRun;
  method: MergeMethod;
  onMethod(method: MergeMethod): void;
  /** The project's check command: null when it has none, undefined while unknown. */
  command: string | null | undefined;
  onSetCommand(): void;
  onOpenPr(number: number): void;
}) {
  const { merge } = props;
  const [logOpen, setLogOpen] = useState(false);
  const run = merge.run;
  if (run) {
    const words = runWords(run, merge.base ?? "main");
    const act = (action: StripAction) => {
      if (action.kind === "stop") return void merge.cancel(run);
      if (action.kind === "dismiss") return merge.dismiss(run);
      if (action.kind === "again") return void merge.again(run);
      if (action.kind === "without") return void merge.without(run, action.pr);
      if (action.kind === "log") return setLogOpen(true);
      if (action.kind === "open") return props.onOpenPr(action.pr);
      props.onSetCommand();
    };
    return (
      <Strip>
        <span className="min-w-0 truncate text-foreground">{words.sentence}</span>
        {words.since !== undefined && (
          <>
            <Dot />
            <Elapsed since={words.since} />
          </>
        )}
        {words.actions.map((action, index) => (
          <span key={action.label} className="contents">
            <Dot />
            <Action lead={index === 0} disabled={merge.pending} onClick={() => act(action)}>
              {action.label}
            </Action>
          </span>
        ))}
        <RunLog run={run} open={logOpen} onOpenChange={setLogOpen} />
      </Strip>
    );
  }
  if (!merge.selected.length) return null;
  return (
    <Strip>
      <span className="min-w-0 truncate text-foreground">
        {`Verify and merge ${pullRequests(merge.selected.length)} into ${merge.base ?? "main"}`}
      </span>
      <Dot />
      <FilterMenu
        label="Merge method"
        align="start"
        value={props.method}
        options={methods}
        onValueChange={props.onMethod}
      />
      <Dot />
      {props.command === null ? (
        <Action lead onClick={props.onSetCommand}>
          Set a check command
        </Action>
      ) : (
        <Action lead disabled={merge.pending} onClick={() => void merge.start(props.method)}>
          Start
        </Action>
      )}
      <Dot />
      <Action onClick={merge.clear}>Clear</Action>
    </Strip>
  );
}

function Strip(props: { children: ReactNode }) {
  return (
    <div
      role="status"
      aria-label="Merge"
      className="flex min-h-9 min-w-0 items-center gap-1 border-t border-border py-1 text-ui"
    >
      {props.children}
    </div>
  );
}
