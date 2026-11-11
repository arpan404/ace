import type { ForgePrDetail, VerifyRun } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { isSettled, useVerifyActions, useVerifyLog, VerifyRefused } from "@/lib/verify.ts";
import { formatElapsed, localCheckAction, localCheckLook } from "@ace/ui-core";
import { PrCheckLog } from "./pr-check-log.tsx";
import { discTone } from "./pr-check-disc.tsx";
import { CheckDetailBox } from "./pr-check-detail.tsx";
import { CheckDetailHead } from "./pr-check-parts.tsx";
import { CheckRow } from "./pr-checks-list.tsx";

/** The local check's name as other checks are named: "Local · bun run check". */
function localName(run: VerifyRun | undefined, command: string | null | undefined) {
  return `Local · ${run?.command ?? command ?? ""}`;
}

function localTone(run: VerifyRun | undefined) {
  return run ? discTone(localCheckLook(run).tone) : "off";
}

/** How long the run took, or has taken so far. */
function took(run: VerifyRun | undefined, now: number): string | undefined {
  if (!run?.startedAt) return undefined;
  const end = run.endedAt ?? (isSettled(run) ? undefined : now);
  return end === undefined ? undefined : formatElapsed(end - run.startedAt);
}

/** The one control the local check offers now, and what pressing it does. */
function useLocalControl(workspaceId: string, detail: ForgePrDetail, run: VerifyRun | undefined) {
  const verify = useVerifyActions(workspaceId);
  const toast = useToast();
  const status = detail.status;
  const live = run !== undefined && !isSettled(run);
  const control = localCheckAction(run);
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
  const button = (label = control.label) => (
    <Button
      size="xs"
      variant="secondary"
      aria-label={control.label}
      disabled={verify.pending || control.disabled}
      onClick={() => void act()}
    >
      {label}
    </Button>
  );
  return { button };
}

/**
 * The PR's local check (ADR 0094) in the list, under "On this machine": its command, how long it
 * took, and Run while it hasn't run. A project without a command offers to set one.
 */
export function LocalCheckRow(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  run: VerifyRun | undefined;
  command: string | null | undefined;
  selected: boolean;
  onSelect(): void;
  onSetCommand: (() => void) | undefined;
}) {
  const { run, command } = props;
  const now = useNow();
  const { button } = useLocalControl(props.workspaceId, props.detail, run);
  if (command === null && !run)
    return (
      <li className="flex min-h-9 items-center gap-2.5 py-1.5 pr-3 pl-3.5 text-ui">
        <span
          aria-hidden
          className="size-4 shrink-0 rounded-full border-[1.5px] border-faint-foreground"
        />
        <span className="min-w-0 flex-1 text-foreground">Local</span>
        {props.onSetCommand && (
          <Button variant="ghost" size="xs" onClick={props.onSetCommand}>
            Set a check command
          </Button>
        )}
      </li>
    );
  return (
    <CheckRow
      label={`${localName(run, command)}: ${localCheckLook(run).word}`}
      name={run?.command ?? command ?? ""}
      tone={localTone(run)}
      selected={props.selected}
      onSelect={props.onSelect}
      trailing={took(run, now)}
      action={!run && !props.selected ? button("Run") : undefined}
    />
  );
}

function LocalLog(props: { run: VerifyRun; name: string }) {
  const log = useVerifyLog(props.run);
  if (log.data) return <PrCheckLog log={log.data} name={props.name} />;
  return (
    <p className="text-ui text-muted-foreground">
      {log.isError ? "Couldn't read the log." : "Reading the log…"}
    </p>
  );
}

/** The local check selected: its state and Run checks, Run again or Stop, then its log. */
export function LocalCheckDetail(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  run: VerifyRun | undefined;
  command: string | null | undefined;
}) {
  const { run } = props;
  const now = useNow();
  const { button } = useLocalControl(props.workspaceId, props.detail, run);
  const name = localName(run, props.command);
  const word = localCheckLook(run).word;
  const time = took(run, now);
  const line = time ? `${word} ${run && !isSettled(run) ? "for" : "after"} ${time}` : word;
  return (
    <CheckDetailBox
      head={<CheckDetailHead tone={localTone(run)} name={name} line={line} actions={button()} />}
    >
      {run ? (
        <LocalLog run={run} name={name} />
      ) : (
        <p className="text-ui text-muted-foreground">
          Runs the project's check command on this branch, here.
        </p>
      )}
    </CheckDetailBox>
  );
}
