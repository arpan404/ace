import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { BackgroundTask } from "@ace/protocol";
import { backgroundGroup } from "@ace/ui-core";
import { CaretRightIcon, TerminalIcon } from "@phosphor-icons/react";
import { Suspense, useCallback, useId, useMemo, useState } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * A background task's line: only turns that start one show it, so its code loads on first use
 * or while the thread screen is idle, off the route's first paint (ADR 0056 route budget).
 */
export const DeferredBackgroundTask = deferredComponent(() =>
  import("./background-task.tsx").then((module) => module.BackgroundTaskLine),
);

/**
 * The line's box while its code loads: one 28px line, or, in a column narrower than 360px where
 * the command wraps under the label, the Stop button's line and the command's.
 */
function Holder() {
  return (
    <div aria-hidden className="@container">
      <div className="flex min-h-7 flex-wrap items-center gap-y-0.5">
        <span className="block h-6 w-px" />
        <span className="hidden h-5 basis-full @max-[360px]:block" />
      </div>
    </div>
  );
}

/** A background task's one line; its box is held while its code loads. */
export function BackgroundTaskLine(props: { threadId: string; itemId: string; taskId: string }) {
  return (
    <Suspense fallback={<Holder />}>
      <DeferredBackgroundTask.Component {...props} />
    </Suspense>
  );
}

type TaskFacts = Pick<BackgroundTask, "status"> | undefined;

/** The group re-renders only when what it shows changes. */
function sameFacts(a: readonly TaskFacts[], b: readonly TaskFacts[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, index) => {
      const y = b[index];
      return x === y || x?.status === y?.status;
    })
  );
}

/**
 * Background commands a turn started back to back, grouped the way tool calls are: "Ran 3
 * background tasks", opened for the ended ones. A running one keeps its own line under the group,
 * Stop and all; an ended one, however quick, has no row outside it.
 */
export function BackgroundTaskGroup(props: {
  threadId: string;
  itemIds: readonly string[];
  taskIds: readonly string[];
}) {
  const { taskIds } = props;
  const [open, setOpen] = useState(false);
  const list = useId();
  const keys = useMemo(() => taskIds.map((id) => `task:${id}` as const), [taskIds]);
  const read = useCallback(
    (reader: ThreadReader): TaskFacts[] =>
      taskIds.map((id) => {
        const task = reader.task(id);
        return task && { status: task.status };
      }),
    [taskIds],
  );
  const group = backgroundGroup(useThread(props.threadId, keys, read, sameFacts) ?? []);
  const line = (index: number) => (
    <BackgroundTaskLine
      key={taskIds[index]}
      threadId={props.threadId}
      itemId={props.itemIds[index] ?? ""}
      taskId={taskIds[index] ?? ""}
    />
  );
  return (
    <div role="group" aria-label={group.label}>
      {group.listed.length ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={list}
          onClick={() => setOpen(!open)}
          className="-mx-1.5 flex min-h-7 items-center gap-2 rounded-sm px-1.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground"
        >
          <TerminalIcon aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
          {group.label}
          <CaretRightIcon
            aria-hidden
            size={12}
            className={cn("transition-transform duration-(--motion-base)", open && "rotate-90")}
          />
        </button>
      ) : (
        <p className="flex min-h-7 items-center gap-2 text-ui text-muted-foreground">
          <TerminalIcon aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
          {group.label}
        </p>
      )}
      {open && group.listed.length > 0 && (
        <div id={list} className="fx-rise-in pl-6">
          {group.listed.map(line)}
        </div>
      )}
      {group.running.length > 0 && <div className="pl-6">{group.running.map(line)}</div>}
    </div>
  );
}
