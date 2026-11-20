import { botFaceStateOf } from "@ace/ui-core/bot-face";
import {
  spadeRunningAlertWords,
  spadeRunningNetworkWords,
  spadeRunningSpendWords,
  spadeRunningUsesWords,
  spadeRunningWakeWords,
  type SpadeRunningAction,
} from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonLook } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { SpadeFace } from "./spade-face.tsx";
import { SpadeMachineScope } from "./spade-machine.tsx";
import { rowPill } from "./spade-profile-parts.tsx";
import { personZone } from "./spade-routines-api.ts";
import { Problem, useSpadeLine } from "./spade-screen-parts.tsx";
import { centeredStrip, SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeRunning, type RunningRow } from "./use-spade-running.ts";

/*
 * Running (ADR 0200 §6.3, docs/design/spade.md §1): everything Spade runs on every machine, one
 * list. Each bot is a row: its face, its name, its state in words, what it holds open, its spend
 * today, its network today and when it next does something by itself, then Stop, Pause or Resume
 * and Open as text buttons. Its workers are listed under it, in words. Spade's own bot is an
 * ordinary row. No head, no foot, no tints: the words carry it.
 */

const actionWords: Record<SpadeRunningAction, string> = {
  stop: "Stop",
  pause: "Pause",
  resume: "Resume",
};

/** The line's colour: the list's needs-you and failed tones only. */
const tone = (row: RunningRow) =>
  row.reads === "needs_you" ? "needs-you" : row.reads === "failed" ? "failed" : undefined;

export function SpadeRunningScreen() {
  const line = useSpadeLine();
  return (
    <Screen page="spade" title="Running">
      <div className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className={cn(readingColumn, "w-full pt-6 pb-10")}>
          {line.ready ? (
            <RunningList />
          ) : (
            <div className="grid min-h-72 place-items-center">
              <SpadeStateStrip line={line} className={centeredStrip} />
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}

function RunningList() {
  const running = useSpadeRunning();
  if (running.failed) return <Problem text="Couldn't read what runs." onRetry={running.refetch} />;
  if (running.loading)
    return (
      <LoadingRegion label="Running" className="flex flex-col gap-4">
        {[0, 1, 2].map((at) => (
          <div key={at} className="flex items-center gap-3">
            <Skeleton className="size-(--spade-list-face) rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-32 rounded" />
              <Skeleton className="h-3.5 w-56 rounded" />
            </div>
          </div>
        ))}
      </LoadingRegion>
    );
  if (running.rows.length === 0)
    return <p className="text-ui text-muted-foreground">Nothing runs yet.</p>;
  return (
    <ul aria-label="Running" className="flex flex-col">
      {running.rows.map((row) => (
        <SpadeMachineScope key={`${row.machine.id}/${row.id}`} machine={row.machine}>
          <RunningItem row={row} act={running.act} />
        </SpadeMachineScope>
      ))}
    </ul>
  );
}

function RunningItem(props: {
  row: RunningRow;
  act(row: RunningRow, action: SpadeRunningAction): Promise<void>;
}) {
  const { row } = props;
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<SpadeRunningAction>();
  const face = botFaceStateOf({ state: row.state, problem: row.failure });
  const uses = spadeRunningUsesWords(row.uses);
  const wake = spadeRunningWakeWords(row, { now, timeZone: personZone() });
  const facts = [
    uses,
    spadeRunningSpendWords(row.spend),
    spadeRunningNetworkWords(row.network),
    wake,
    row.machine.primary ? undefined : `On ${row.machine.name}`,
  ].filter(Boolean);
  const run = (action: SpadeRunningAction) => {
    setBusy(action);
    props
      .act(row, action)
      .catch((error: unknown) =>
        toast.error({
          title: `Couldn't ${actionWords[action].toLowerCase()} ${row.name}`,
          description: error instanceof Error ? error.message : undefined,
        }),
      )
      .finally(() => setBusy(undefined));
  };
  return (
    <li
      data-running-row={row.reads}
      className="flex gap-3 border-b border-border/60 py-3.5 last:border-b-0"
    >
      <SpadeFace avatar={row.avatar} size={40} state={face} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-md/5 font-medium text-foreground">{row.name}</p>
        <p
          data-tone={tone(row)}
          className={cn(
            "text-ui/5",
            tone(row) ? "font-medium text-(--tone-text)" : "text-muted-foreground",
          )}
        >
          {row.doing}
        </p>
        <p className="mt-0.5 text-ui/5 text-subtle-foreground">{facts.join(" · ")}</p>
        {spadeRunningAlertWords(row.spend) && row.spend.unusual && (
          <p className="text-ui/5 text-subtle-foreground">{spadeRunningAlertWords(row.spend)}</p>
        )}
        {row.workers.length > 0 && (
          <ul aria-label={`${row.name}'s workers`} className="mt-1.5 flex flex-col gap-0.5">
            {row.workers.map((worker) => (
              <li key={worker.id} className="truncate text-ui/5 text-muted-foreground">
                <span className="text-foreground">{worker.name}</span> · {worker.doing}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        {row.actions.map((action) => (
          <Button
            key={action}
            variant="ghost"
            size="sm"
            className={rowPill}
            disabled={busy !== undefined}
            aria-label={`${actionWords[action]} ${row.name}`}
            onClick={() => run(action)}
          >
            {actionWords[action]}
          </Button>
        ))}
        <Link
          to="/spade/$agentId"
          params={{ agentId: row.id }}
          search={row.machine.primary ? {} : { on: row.machine.id }}
          aria-label={`Open ${row.name}`}
          {...buttonLook({ variant: "ghost", size: "sm" }, rowPill)}
        >
          Open
        </Link>
      </div>
    </li>
  );
}
