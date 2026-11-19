import { useEffect, useState } from "react";
import { useNow } from "@/lib/time.ts";
import { Button } from "@/components/ui/button.tsx";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { PrCheckDetail } from "./pr-check-detail.tsx";
import { LocalCheckDetail, LocalCheckRow } from "./pr-local-check-row.tsx";
import { usePrLocalCheck } from "./pr-local-check.ts";
import {
  CheckGroup,
  CheckRow,
  ChecksListBox,
  checkDuration,
  checkState,
  sortChecks,
} from "./pr-checks-list.tsx";
import { useProjectDialogsIfHosted } from "@/features/projects/index.ts";

/** The local check's place in the selection, beside GitHub's check ids. */
const localId = "local";

/**
 * The PR's checks as the Checks tab: a list grouped by where they ran, failures first, beside
 * the selected check's detail (its log, annotations and re-runs). Narrow, the list sits above the
 * detail. It opens at the first failing check; `focus` (Open log from the merge box) picks and
 * reveals one. When the host couldn't say, one inline Refresh.
 */
export function PrChecks(props: {
  context: PrWorkspaceContext;
  refreshing: boolean;
  /** Selects this check and scrolls to it; `seq` repeats a jump to the same one. */
  focus?: { id: string; seq: number } | undefined;
  hostThreadId?: string | undefined;
  onRefresh(): void;
  onOpen(number: number): void;
  onOpenCode(path: string): void;
}) {
  const { status } = props.context.detail;
  const stale = status.ci === "unknown";
  const local = usePrLocalCheck(props.context.workspaceId, status);
  const dialogs = useProjectDialogsIfHosted();
  const workspaceId = props.context.workspaceId;
  // Open PRs always show their local check; finished ones only one that ran.
  const unfinished = status.state === "open" || status.state === "draft";
  const showLocal = local.run !== undefined || (unfinished && local.command !== undefined);
  // A project without a command has nothing to select, only a way to set one.
  const localSelectable = showLocal && (local.run !== undefined || local.command !== null);
  const localFailed = local.result === "failed";
  const now = useNow();
  const checks = sortChecks(status.checks);
  const [picked, setPicked] = useState<string | undefined>(props.focus?.id);
  // A new focus selects its check during render; the detail scrolls itself into view.
  const [focused, setFocused] = useState(props.focus);
  if (props.focus !== focused) {
    setFocused(props.focus);
    if (props.focus) setPicked(props.focus.id);
  }
  useEffect(() => {
    if (focused)
      document
        .getElementById("pr-check-detail")
        ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  // What was picked while it still exists; else the first failure (the local one leads only
  // when it failed), else the first check.
  const ids = [
    ...(localFailed && localSelectable ? [localId] : []),
    ...checks.map((check) => check.id),
    ...(!localFailed && localSelectable ? [localId] : []),
  ];
  const firstFailing = localFailed
    ? localId
    : checks.find((check) => check.status === "failure")?.id;
  const selected = picked !== undefined && ids.includes(picked) ? picked : (firstFailing ?? ids[0]);
  const selectedCheck = checks.find((check) => check.id === selected);
  const localRow = showLocal && (
    <CheckGroup title="On this machine">
      <LocalCheckRow
        workspaceId={workspaceId}
        detail={props.context.detail}
        run={local.run}
        command={local.command}
        selected={selected === localId}
        onSelect={() => setPicked(localId)}
        onSetCommand={
          dialogs ? () => dialogs.open({ kind: "edit", projectId: workspaceId }) : undefined
        }
      />
    </CheckGroup>
  );
  const empty = !status.checks.length && !showLocal;
  return (
    <section aria-label="Checks" className="space-y-3 pt-2">
      {stale && (
        <p className="flex items-center gap-2 text-ui text-muted-foreground">
          Check details are out of date.
          <Button variant="ghost" size="xs" disabled={props.refreshing} onClick={props.onRefresh}>
            Refresh
          </Button>
        </p>
      )}
      {empty && !stale && <p className="text-ui text-muted-foreground">No checks reported.</p>}
      {!empty && (
        <div className="grid items-start gap-4 @min-[40rem]/pr:grid-cols-[16.25rem_minmax(0,1fr)] @min-[40rem]/pr:gap-5">
          <ChecksListBox>
            {localFailed && localRow}
            {checks.length > 0 && (
              <CheckGroup
                title={
                  <>
                    Checks on <span className="font-mono">{status.headSha.slice(0, 7)}</span>
                  </>
                }
              >
                {checks.map((check) => {
                  const state = checkState(check);
                  return (
                    <CheckRow
                      key={check.id}
                      label={`${check.name}: ${state.word}`}
                      name={check.name}
                      tone={state.tone}
                      selected={check.id === selected}
                      onSelect={() => setPicked(check.id)}
                      trailing={checkDuration(check, now)}
                    />
                  );
                })}
              </CheckGroup>
            )}
            {!localFailed && localRow}
          </ChecksListBox>
          {selectedCheck ? (
            <PrCheckDetail
              key={selectedCheck.id}
              context={props.context}
              check={selectedCheck}
              hostThreadId={props.hostThreadId}
              onOpen={props.onOpen}
              onOpenCode={props.onOpenCode}
            />
          ) : (
            selected === localId && (
              <LocalCheckDetail
                workspaceId={workspaceId}
                detail={props.context.detail}
                run={local.run}
                command={local.command}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}
