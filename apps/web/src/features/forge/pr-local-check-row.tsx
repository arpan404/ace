import { useState } from "react";
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgePrDetail, VerifyRun } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { isSettled, useVerifyActions, useVerifyLog, VerifyRefused } from "@/lib/verify.ts";
import { PrCheckLog } from "./pr-check-log.tsx";

type Look = { icon: typeof CircleIcon; word: string; tone: string };
const looks: Partial<Record<VerifyRun["state"], Look>> = {
  queued: { icon: ClockIcon, word: "Queued", tone: "text-status-working" },
  running: { icon: ClockIcon, word: "Running", tone: "text-status-working" },
  passed: { icon: CheckCircleIcon, word: "Passed", tone: "text-status-done" },
  failed: { icon: XCircleIcon, word: "Failed", tone: "text-status-failed" },
  cancelled: { icon: MinusCircleIcon, word: "Stopped", tone: "text-subtle-foreground" },
  interrupted: { icon: MinusCircleIcon, word: "Interrupted", tone: "text-subtle-foreground" },
};
const notRun: Look = { icon: CircleIcon, word: "Not run", tone: "text-faint-foreground" };

const row =
  "flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui transition-colors duration-(--motion-fast)";

function LocalLog(props: { run: VerifyRun; name: string }) {
  const log = useVerifyLog(props.run);
  if (log.data) return <PrCheckLog log={log.data} name={props.name} />;
  return (
    <p className="text-xs text-muted-foreground">
      {log.isError ? "Couldn't read the log." : "Reading the log…"}
    </p>
  );
}

/**
 * The PR's local check (ADR 0094) as one more check: "Local · <command>" with its state, opening
 * to its log and Run checks, Run again or Stop. A project without a command offers to set one.
 */
export function LocalCheckRow(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  run: VerifyRun | undefined;
  command: string | null | undefined;
  onSetCommand: (() => void) | undefined;
}) {
  const { run, command, detail } = props;
  const [open, setOpen] = useState(false);
  const verify = useVerifyActions(props.workspaceId);
  const toast = useToast();
  const status = detail.status;
  const live = run !== undefined && !isSettled(run);
  if (command === null && !run)
    return (
      <li className={cn(row, "py-0.5")}>
        <CircleIcon aria-hidden size={14} className="shrink-0 text-faint-foreground" />
        <span className="min-w-0 flex-1">Local</span>
        {props.onSetCommand && (
          <Button variant="ghost" size="xs" onClick={props.onSetCommand}>
            Set a check command
          </Button>
        )}
      </li>
    );
  const name = `Local · ${run?.command ?? command ?? ""}`;
  const look = (run && looks[run.state]) ?? notRun;
  const Glyph = look.icon;
  const act = async () => {
    try {
      if (run && live) await verify.cancel(run.id);
      else
        await verify.start({
          kind: "check",
          pr: { pr: status.ref, headSha: status.headSha, title: status.title.slice(0, 512) },
        });
    } catch (error) {
      toast.error({
        title: live ? "Couldn't stop the check" : "Couldn't run the check",
        description:
          error instanceof VerifyRefused && error.code === "no_command"
            ? "This project has no check command."
            : error instanceof VerifyRefused && error.code === "busy"
              ? "Too many runs are waiting in this project."
              : "Verify didn't answer. Try again.",
      });
    }
  };
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${name}: ${look.word}`}
        onClick={() => setOpen((current) => !current)}
        className={cn(row, "focus-ring-inset hover:bg-hover aria-expanded:bg-active")}
      >
        <Glyph aria-hidden size={14} className={cn("shrink-0", look.tone)} />
        <span className="min-w-0 flex-1 break-words">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{look.word}</span>
        <CaretRightIcon
          aria-hidden
          size={12}
          className={cn(
            "shrink-0 text-faint-foreground transition-transform duration-(--motion-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 py-2 pl-7">
          <Button
            variant="ghost"
            size="xs"
            className="-ml-1.5"
            disabled={verify.pending || run?.state === "merging"}
            onClick={() => void act()}
          >
            {live ? "Stop" : run ? "Run again" : "Run checks"}
          </Button>
          {run && <LocalLog run={run} name={name} />}
        </div>
      )}
    </li>
  );
}
