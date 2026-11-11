import { useState, type ReactNode } from "react";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, DotsThreeIcon } from "@phosphor-icons/react";
import type { ForgeCheck, ForgeCheckRun } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { prBox } from "./pr-box.tsx";
import { PrCheckLog } from "./pr-check-log.tsx";
import { checkControls, checkFixRequest, checkLogNote, checkRunId } from "@ace/ui-core";
import { useCheckRerun, useCheckRun } from "./pr-check-run.ts";
import { useFixWithAgent } from "./pr-fix-with-agent.ts";
import { readFailureText } from "./query-state.tsx";
import { Annotations, CheckDetailHead, Output, Steps, checkLine } from "./pr-check-parts.tsx";
import { checkState } from "./pr-checks-list.tsx";

/** The right pane's box: a head, then its body padded below. */
export function CheckDetailBox(props: { head: ReactNode; children: ReactNode }) {
  return (
    <section id="pr-check-detail" aria-label="Check" className={cn(prBox, "min-w-0 scroll-mt-12")}>
      {props.head}
      <div className="space-y-3.5 px-4 pt-3.5 pb-4">{props.children}</div>
    </section>
  );
}

/** Fix with agent, Re-run failed jobs, Cancel run; Re-run all and GitHub under ⋯. */
function Actions(props: {
  context: PrWorkspaceContext;
  check: ForgeCheck;
  run: ForgeCheckRun;
  hostThreadId: string | undefined;
  openOnGitHub: (() => void) | undefined;
}) {
  const { context, check, run } = props;
  const { detail, workspaceId } = context;
  const pr = detail.status.ref;
  const rerun = useCheckRerun({ workspaceId, pr, onDone: context.refresh });
  const agent = useFixWithAgent({ workspaceId, detail, hostThreadId: props.hostThreadId });
  const open = detail.status.state === "open" || detail.status.state === "draft";
  const controls = checkControls(check, run, open);
  const workflow = run.workflow;
  const reason = context.disabled ? "Wait for GitHub to refresh" : undefined;
  const blocked = rerun.pending || context.disabled;
  const rerunAll =
    workflow && controls.rerunAll
      ? () =>
          void rerun.run({
            kind: "rerun",
            runId: workflow.runId,
            attempt: workflow.attempt,
            jobs: "all",
          })
      : undefined;
  return (
    <>
      {controls.fix && (
        <Button
          size="xs"
          variant="secondary"
          onClick={() =>
            agent.ask(
              checkFixRequest(check, { number: pr.number, url: detail.status.url }, run),
              `check:${check.id}`,
            )
          }
        >
          Fix with agent
        </Button>
      )}
      {workflow && controls.rerunFailed && (
        <DisabledReason reason={reason}>
          <Button
            size="xs"
            variant="secondary"
            disabled={blocked}
            onClick={() =>
              void rerun.run({
                kind: "rerun",
                runId: workflow.runId,
                attempt: workflow.attempt,
                jobs: "failed",
              })
            }
          >
            Re-run failed jobs
          </Button>
        </DisabledReason>
      )}
      {workflow && controls.cancel && (
        <DisabledReason reason={reason}>
          <Button
            size="xs"
            variant="secondary"
            className="text-status-failed"
            disabled={blocked}
            onClick={() =>
              void rerun.run({ kind: "cancel", runId: workflow.runId, attempt: workflow.attempt })
            }
          >
            Cancel run
          </Button>
        </DisabledReason>
      )}
      {(rerunAll || props.openOnGitHub) && (
        <Menu>
          <MenuTrigger
            render={<IconButton size="sm" icon={DotsThreeIcon} label={`More for ${check.name}`} />}
          />
          <MenuContent align="end">
            {rerunAll && (
              <MenuItem
                icon={<ArrowsClockwiseIcon aria-hidden size={16} />}
                disabled={blocked}
                onClick={rerunAll}
              >
                Re-run all jobs
              </MenuItem>
            )}
            {props.openOnGitHub && (
              <MenuItem
                icon={<ArrowSquareOutIcon aria-hidden size={16} />}
                onClick={props.openOnGitHub}
              >
                Open on GitHub
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
      )}
    </>
  );
}

/**
 * The selected check: its head with re-runs and "Fix with agent", its annotations, its steps and
 * its log opened at the failing step, or for another app's check what that app reported. GitHub
 * is linked when ace has nothing of the check to show, and from ⋯ otherwise.
 */
export function PrCheckDetail(props: {
  context: PrWorkspaceContext;
  check: ForgeCheck;
  hostThreadId?: string | undefined;
  onOpen(number: number): void;
  onOpenCode(path: string): void;
}) {
  const { context, check } = props;
  const { detail, workspaceId } = context;
  const pr = detail.status.ref;
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const now = useNow();
  const known = checkRunId(check) !== undefined;
  const query = useCheckRun({ workspaceId, pr, check, enabled: known });
  const [jump, setJump] = useState<{ line: number; seq: number }>();
  const url = check.url;
  const openOnGitHub = url
    ? () => void openWeb(url).catch(() => toast.error({ title: "Couldn't open the check" }))
    : undefined;
  const githubButton = openOnGitHub && (
    <Button variant="ghost" size="xs" className="-ml-1.5" onClick={openOnGitHub}>
      <ArrowSquareOutIcon aria-hidden size={12} />
      Open on GitHub
    </Button>
  );
  const run = known && query.isSuccess ? query.data : undefined;
  const head = (
    <CheckDetailHead
      tone={checkState(check).tone}
      name={check.name}
      line={checkLine(check, now)}
      actions={
        run && (
          <Actions
            context={context}
            check={check}
            run={run}
            hostThreadId={props.hostThreadId}
            openOnGitHub={openOnGitHub}
          />
        )
      }
    />
  );
  if (!known)
    return (
      <CheckDetailBox head={head}>
        {githubButton || (
          <p className="text-ui text-muted-foreground">
            GitHub reports nothing more for this check.
          </p>
        )}
      </CheckDetailBox>
    );
  if (query.isPending)
    return (
      <CheckDetailBox head={head}>
        <div role="status" aria-label={`Reading ${check.name}`}>
          <SkeletonText lines={4} />
        </div>
      </CheckDetailBox>
    );
  if (!run)
    return (
      <CheckDetailBox head={head}>
        <p role="alert" className="flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
          {`Couldn't read this check. ${query.error ? readFailureText(query.error) : ""}`}
          <Button size="xs" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </p>
      </CheckDetailBox>
    );
  const workflow = run.workflow;
  const blank =
    !run.log &&
    !run.annotations.length &&
    !run.output.title &&
    !run.output.summary &&
    !run.output.text;
  const note = checkLogNote(check, run);
  return (
    <CheckDetailBox head={head}>
      <Annotations
        annotations={run.annotations}
        truncated={run.annotationsTruncated}
        onOpenCode={props.onOpenCode}
      />
      {!run.log && <Output run={run} context={context} onOpen={props.onOpen} />}
      {run.log && workflow && (
        <Steps
          steps={workflow.steps}
          onJump={(line) => setJump((current) => ({ line, seq: (current?.seq ?? 0) + 1 }))}
        />
      )}
      {run.log && <PrCheckLog log={run.log} name={check.name} jump={jump} />}
      {note && <p className="text-ui text-muted-foreground">{note}</p>}
      {blank &&
        !note &&
        (githubButton || (
          <p className="text-ui text-muted-foreground">Nothing more was reported for this check.</p>
        ))}
    </CheckDetailBox>
  );
}
