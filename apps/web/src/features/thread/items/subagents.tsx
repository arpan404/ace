import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useThread } from "@ace/client-react";
import { CaretRightIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useCallback, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { AgentBranch, AgentRow } from "./agent-row.tsx";

/** [parent agent, ...children] for a run of spawn calls. */
function spawned(reader: ThreadReader, itemIds: readonly string[]): string[] {
  const spawns = new Set(itemIds);
  const children: string[] = [];
  let parent: string | undefined;
  for (const id of itemIds) {
    const item = reader.item(id);
    if (item?.type !== "tool_call") continue;
    parent ??= item.agentId;
    if (item.call.detail.kind === "agent.spawn" && item.call.detail.childAgentId)
      children.push(item.call.detail.childAgentId);
  }
  for (const agentId of reader.agentIds()) {
    const by = reader.agent(agentId)?.spawnedBy;
    if (by && spawns.has(by) && !children.includes(agentId)) children.push(agentId);
  }
  return parent ? [parent, ...children] : children;
}

/** "Started 2 subagents ›", expanding inline into that part of the agent tree. */
export function Subagents(props: { threadId: string; itemIds: readonly string[] }) {
  const keys = useMemo<ThreadKey[]>(
    () => ["agents", ...props.itemIds.map((id): ThreadKey => `item:${id}`)],
    [props.itemIds],
  );
  const read = useCallback(
    (reader: ThreadReader) => spawned(reader, props.itemIds),
    [props.itemIds],
  );
  const [parent, ...children] = useThread(props.threadId, keys, read, arrayEqual) ?? [];
  const [open, setOpen] = useState(false);
  const { setPanelOpen, setTab } = useLayout();
  const tree = useId();
  const count = Math.max(children.length, props.itemIds.length);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={tree}
        onClick={() => setOpen(!open)}
        className="-mx-1.5 inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-1.5 text-[13.5px] text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
      >
        Started {count} {count === 1 ? "subagent" : "subagents"}
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(
            "text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div
          id={tree}
          className="mt-1 mb-2 ml-2.5 animate-in border-l-2 pl-2.5 duration-(--dur-2) fade-in slide-in-from-top-1"
        >
          <div role="tree" aria-label="Subagents">
            {parent && <AgentRow threadId={props.threadId} agentId={parent} depth={0} />}
            {children.map((child) => (
              <AgentBranch key={child} threadId={props.threadId} agentId={child} depth={1} />
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1"
            onClick={() => {
              setTab("right", "agents");
              setPanelOpen("right", true);
            }}
          >
            <TreeStructureIcon aria-hidden size={14} />
            Open agent tree
            <Kbd keys={keymap.agents.keys} />
          </Button>
        </div>
      )}
    </div>
  );
}
