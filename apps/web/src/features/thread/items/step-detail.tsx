import { useClient } from "@ace/client-react";
import type { FileChange, Item, OutputSummary } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { patchLines } from "@ace/ui-core";
import { readOutputText } from "@/lib/output-read.ts";

/** The expanded body of a work-log row: command output, diffs, reasoning or the error. */
export function StepDetail(props: { item: Item }) {
  const item = props.item;
  if (item.type === "reasoning")
    return (
      <p className="text-ui leading-normal whitespace-pre-wrap text-muted-foreground">
        {item.text}
      </p>
    );
  if (item.type === "notice")
    return <p className="text-ui whitespace-pre-wrap text-muted-foreground">{item.text}</p>;
  if (item.type !== "tool_call") return null;
  const { detail, error } = item.call;
  return (
    <div className="flex flex-col gap-2">
      {detail.kind === "shell" && (
        <ShellOutput
          command={detail.command}
          cwd={detail.cwd}
          output={detail.output}
          exitCode={detail.exitCode}
          running={item.call.status === "running"}
        />
      )}
      {"changes" in detail &&
        detail.changes.map((change) => <ChangeDiff key={change.path} change={change} />)}
      {detail.kind === "search" && (
        <p className="text-ui text-muted-foreground">
          <code className="font-mono text-foreground">{detail.query}</code>
          {detail.path && (
            <>
              {" "}
              in <code className="font-mono">{detail.path}</code>
            </>
          )}
        </p>
      )}
      {detail.kind === "agent.message" && detail.message && (
        <p className="text-ui whitespace-pre-wrap text-muted-foreground">{detail.message}</p>
      )}
      {error && (
        <p role="alert" className="text-ui text-status-failed">
          {error}
        </p>
      )}
    </div>
  );
}

function ShellOutput(props: {
  command: string;
  cwd?: string | undefined;
  output?: OutputSummary | undefined;
  exitCode?: number | null | undefined;
  running: boolean;
}) {
  const [full, setFull] = useState<string>();
  const text = full ?? props.output?.tail ?? "";
  return (
    <div className="overflow-hidden rounded-card bg-code shadow-[inset_0_0_0_1px_var(--border)]">
      <pre className="overflow-x-auto px-3 pt-2.5 font-mono text-[12px] leading-[1.55]">
        <span className="text-subtle-foreground">$ </span>
        {props.command}
      </pre>
      {text && (
        <pre
          aria-label="Output"
          className="max-h-72 overflow-auto px-3 pt-1 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-muted-foreground"
        >
          {props.output?.truncated && !full ? "…\n" : ""}
          {text}
        </pre>
      )}
      <div className="flex h-8 items-center gap-2 px-3 text-xs text-subtle-foreground">
        {props.running ? (
          <>
            <Spinner /> Running
          </>
        ) : props.exitCode !== undefined && props.exitCode !== null ? (
          <span className={cn(props.exitCode !== 0 && "text-status-failed")}>
            Exit code {props.exitCode}
          </span>
        ) : null}
        {props.cwd && <span className="truncate font-mono">{props.cwd}</span>}
        {props.output?.truncated && !full && (
          <FullOutput streamId={props.output.streamId} onLoaded={setFull} />
        )}
      </div>
    </div>
  );
}

/** Reads the whole output from the daemon's stream store (ADR 0006), bounded at 1 MiB. */
function FullOutput(props: { streamId: string; onLoaded(text: string): void }) {
  const client = useClient();
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const load = async () => {
    setState("loading");
    try {
      props.onLoaded(await readOutputText(client, props.streamId));
    } catch {
      setState("failed");
    }
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      className="ml-auto"
      disabled={state === "loading"}
      onClick={() => void load()}
    >
      {state === "loading" && <Spinner />}
      {state === "failed" ? "Couldn't load the output. Retry" : "Show full output"}
    </Button>
  );
}

const lineTone = {
  add: "bg-diff-add",
  del: "bg-diff-del",
  context: "",
  hunk: "text-subtle-foreground",
};
const sign = { add: "+", del: "−", context: " ", hunk: "" };

/** One file's change as a compact unified diff. */
export function ChangeDiff(props: { change: FileChange }) {
  const { change } = props;
  const lines = change.diff
    ? patchLines(change.diff)
    : (change.newText ?? "").split("\n").map((text) => ({ kind: "add" as const, text }));
  return (
    <figure className="overflow-hidden rounded-card shadow-[inset_0_0_0_1px_var(--border)]">
      <figcaption className="flex h-8 items-center gap-2 border-b px-3 font-mono text-xs text-muted-foreground">
        {change.movePath ? `${change.path} → ${change.movePath}` : change.path}
        {change.kind !== "update" && <span className="text-subtle-foreground">{change.kind}</span>}
      </figcaption>
      <pre
        aria-label={`Diff of ${change.path}`}
        className="max-h-80 overflow-auto py-1 font-mono text-[12px] leading-[1.6]"
      >
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- diff lines repeat; position is identity.
          <div key={index} className={cn("flex px-3", lineTone[line.kind])}>
            <span
              aria-hidden
              className={cn(
                "w-4 shrink-0 select-none",
                line.kind === "add" && "text-status-done",
                line.kind === "del" && "text-status-failed",
              )}
            >
              {sign[line.kind]}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        ))}
      </pre>
    </figure>
  );
}
