import type { Item, ToolStatus } from "@ace/protocol";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.tsx";
import { StatusPill } from "@/components/status-pill.tsx";
import type { Tone } from "@/lib/status.ts";
import {
  BotIcon,
  ChevronRightIcon,
  FileIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

type ToolItem = Extract<Item, { type: "tool_call" }>;

const statuses: Record<ToolStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "idle" },
  awaiting_approval: { label: "Awaiting approval", tone: "needs-you" },
  running: { label: "Running", tone: "working" },
  succeeded: { label: "Done", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  declined: { label: "Declined", tone: "idle" },
  cancelled: { label: "Cancelled", tone: "idle" },
};
function icon(kind: string): ReactNode {
  if (kind === "shell") return <TerminalIcon />;
  if (kind === "search" || kind === "web.search") return <SearchIcon />;
  if (kind.startsWith("file.")) return <FileIcon />;
  if (kind === "agent.spawn" || kind === "agent.message") return <BotIcon />;
  return <WrenchIcon />;
}

/** AI Elements "tool" pattern, adapted to ace's typed ToolCall and Base UI Collapsible. */
export function ToolCallItemView(props: { item: ToolItem }) {
  const call = props.item.call;
  const status = statuses[call.status];
  return (
    <Collapsible defaultOpen={call.status === "awaiting_approval"} className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
        <ChevronRightIcon className="transition-transform group-data-[panel-open]:rotate-90" />
        {icon(call.kind)}
        <span className="min-w-0 flex-1 truncate">{call.title}</span>
        <StatusPill tone={status.tone} label={status.label} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2 text-xs">
        <ToolDetail item={props.item} />
        {call.error && <p className="mt-2 text-status-failed">{call.error}</p>}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolDetail(props: { item: ToolItem }) {
  const detail = props.item.call.detail;
  switch (detail.kind) {
    case "shell":
      return (
        <div className="flex flex-col gap-2">
          <pre className="overflow-x-auto rounded bg-muted p-2 font-mono">$ {detail.command}</pre>
          {detail.output && detail.output.tail && (
            <pre
              aria-label="Output"
              className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap"
            >
              {detail.output.truncated ? "…\n" : ""}
              {detail.output.tail}
            </pre>
          )}
        </div>
      );
    case "search":
      return (
        <p>
          <code>{detail.query}</code>
          {detail.path && <> in {detail.path}</>}
        </p>
      );
    case "agent.spawn":
      return <p>{detail.description ?? detail.prompt ?? "Subagent"}</p>;
    case "file.read":
      return <code>{detail.path}</code>;
    case "file.edit":
    case "file.write":
    case "file.delete":
    case "file.move":
      return (
        <ul>
          {detail.changes.map((change) => (
            <li key={change.path}>
              <code>{change.path}</code> ({change.kind})
            </li>
          ))}
        </ul>
      );
    default:
      return <p className="text-muted-foreground">{props.item.call.kind}</p>;
  }
}
