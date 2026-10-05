import { useAgent, useClient } from "@ace/client-react";
import type { FileChange, Item, OutputSummary, TodoEntry } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { PermissionReviewFacts } from "@/components/permission-review.tsx";
import { displayCommand, patchLines, stepPath } from "@ace/ui-core";
import { useItemInteraction } from "../interactions/use-item-interaction.ts";
import { readOutputText } from "@/lib/output-read.ts";

/**
 * The expanded body of a work-log row (IR-7): command output, diffs, the file read, the tool's
 * arguments, the plan, reasoning, the error in full, and the review of the approval that gated
 * it. With `threadId`, paths read relative to the agent's directory and the review shows.
 */
export function StepDetail(props: { item: Item; threadId?: string | undefined }) {
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
  return props.threadId ? (
    <CallDetail threadId={props.threadId} item={item} />
  ) : (
    <CallBody item={item} cwd={undefined} />
  );
}

type ToolItem = Extract<Item, { type: "tool_call" }>;

function CallDetail(props: { threadId: string; item: ToolItem }) {
  const agent = useAgent(props.threadId, props.item.agentId);
  const interaction = useItemInteraction(props.threadId, props.item.id);
  return (
    <div className="flex flex-col gap-2">
      <CallBody item={props.item} cwd={agent?.cwd} />
      {interaction?.review && interaction.state !== "pending" && (
        <PermissionReviewFacts
          review={interaction.review}
          interaction={interaction}
          cwd={agent?.cwd}
        />
      )}
    </div>
  );
}

function CallBody(props: { item: ToolItem; cwd: string | undefined }) {
  const { detail, error, raw, title } = props.item.call;
  const context = { cwd: props.cwd };
  const command = detail.kind === "shell" ? displayCommand(detail) : undefined;
  return (
    <div className="flex flex-col gap-2">
      {detail.kind === "shell" && command && (
        <ShellOutput
          command={command.command}
          raw={command.raw}
          cwd={detail.cwd ? stepPath(detail.cwd, context).text : undefined}
          output={detail.output}
          exitCode={detail.exitCode}
          running={props.item.call.status === "running"}
        />
      )}
      {"changes" in detail &&
        detail.changes.map((change) => (
          <ChangeDiff key={change.path} change={change} cwd={props.cwd} />
        ))}
      {detail.kind === "file.read" && (
        <p className="text-ui text-muted-foreground">
          <code className="font-mono text-[12px] break-all text-foreground">{detail.path}</code>
          {detail.range && (
            <span>
              {" "}
              · lines {detail.range.start}–{detail.range.end}
            </span>
          )}
        </p>
      )}
      {detail.kind === "search" && (
        <p className="text-ui text-muted-foreground">
          <code className="font-mono text-foreground">{detail.query}</code>
          {detail.path && (
            <>
              {" "}
              in <code className="font-mono">{stepPath(detail.path, context).text}</code>
            </>
          )}
          {detail.matches !== undefined && <> · {detail.matches} matches</>}
        </p>
      )}
      {detail.kind === "web.search" && (
        <p className="text-ui text-muted-foreground">
          Searched for <q className="text-foreground">{detail.query}</q>
        </p>
      )}
      {detail.kind === "web.fetch" && (
        <a
          href={detail.url}
          target="_blank"
          rel="noreferrer"
          className="text-ui break-all text-foreground underline underline-offset-2"
        >
          {detail.url}
        </a>
      )}
      {detail.kind === "mcp" && (
        <>
          <p className="text-ui text-muted-foreground">
            {detail.server} · {detail.tool}
          </p>
          {detail.arguments !== undefined && (
            <JsonBlock label="Arguments" value={detail.arguments} />
          )}
        </>
      )}
      {(detail.kind === "todo" || detail.kind === "plan") && (
        <>
          {detail.kind === "plan" && detail.markdown && (
            <p className="text-ui whitespace-pre-wrap text-muted-foreground">{detail.markdown}</p>
          )}
          <TodoList todos={detail.todos ?? []} />
        </>
      )}
      {detail.kind === "agent.message" && detail.message && (
        <p className="text-ui whitespace-pre-wrap text-muted-foreground">{detail.message}</p>
      )}
      {["browser", "image", "notebook", "custom"].includes(detail.kind) && (
        <p className="text-ui text-muted-foreground">{title}</p>
      )}
      {error && (
        <p role="alert" className="text-ui whitespace-pre-wrap text-status-failed">
          {error}
        </p>
      )}
      {(detail.kind === "mcp" ||
        ["browser", "image", "notebook", "custom"].includes(detail.kind)) &&
        raw.length > 0 && <JsonBlock label="Raw" value={raw} collapsed />}
    </div>
  );
}

const todoGlyphs = { pending: "☐", in_progress: "▸", completed: "✓", cancelled: "✕" } as const;

function TodoList(props: { todos: readonly TodoEntry[] }) {
  if (!props.todos.length) return null;
  return (
    <ul aria-label="Plan" className="flex flex-col gap-0.5 text-ui">
      {props.todos.map((todo, index) => (
        <li
          // oxlint-disable-next-line react/no-array-index-key -- todo text repeats; position is identity.
          key={index}
          className={cn(
            "flex gap-2",
            todo.status === "completed" || todo.status === "cancelled"
              ? "text-subtle-foreground"
              : "text-foreground",
            todo.status === "cancelled" && "line-through",
          )}
        >
          <span aria-label={todo.status.replace("_", " ")} className="w-3 shrink-0 text-center">
            {todoGlyphs[todo.status]}
          </span>
          <span>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** Pretty JSON, read-only; long values fold after six lines. */
function JsonBlock(props: { label: string; value: unknown; collapsed?: boolean }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(props.value, null, 2) ?? "";
    } catch {
      return String(props.value);
    }
  }, [props.value]);
  const lines = text.split("\n");
  const long = lines.length > 6;
  const [open, setOpen] = useState(!props.collapsed && !long);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="self-start text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {props.label}
        {!open && long ? ` · ${lines.length} lines` : ""}
      </button>
      <pre
        className={cn(
          "overflow-auto rounded-md bg-code px-3 py-2 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap text-muted-foreground",
          open ? "max-h-80" : "max-h-[6lh]",
        )}
      >
        {open || !long ? text : lines.slice(0, 6).join("\n")}
      </pre>
    </div>
  );
}

function ShellOutput(props: {
  command: string;
  raw?: string | undefined;
  cwd?: string | undefined;
  output?: OutputSummary | undefined;
  exitCode?: number | null | undefined;
  running: boolean;
}) {
  const [full, setFull] = useState<string>();
  const text = full ?? props.output?.tail ?? "";
  return (
    <div className="overflow-hidden rounded-card bg-code shadow-[inset_0_0_0_1px_var(--border)]">
      <pre className="overflow-x-auto px-3 pt-2.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap">
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
      {props.raw && (
        <p className="px-3 pt-1 font-mono text-[11.5px] break-all text-subtle-foreground">
          Raw: {props.raw}
        </p>
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
export function ChangeDiff(props: { change: FileChange; cwd?: string | undefined }) {
  const { change } = props;
  const path = (value: string) => stepPath(value, { cwd: props.cwd }).text;
  const lines = change.diff
    ? patchLines(change.diff)
    : (change.newText ?? "").split("\n").map((text) => ({ kind: "add" as const, text }));
  return (
    <figure className="overflow-hidden rounded-card shadow-[inset_0_0_0_1px_var(--border)]">
      <figcaption className="flex h-8 items-center gap-2 border-b px-3 font-mono text-xs text-muted-foreground">
        <span title={change.movePath ?? change.path} className="truncate">
          {change.movePath ? `${path(change.path)} → ${path(change.movePath)}` : path(change.path)}
        </span>
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
