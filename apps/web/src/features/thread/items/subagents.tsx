import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useThread } from "@ace/client-react";
import { CaretRightIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useCallback, useId, useMemo, useState } from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { AgentBranch } from "./agent-row.tsx";

/** The agents a run of spawn calls started. */
function spawned(reader: ThreadReader, itemIds: readonly string[]): string[] {
  const spawns = new Set(itemIds);
  const children: string[] = [];
  for (const id of itemIds) {
    const item = reader.item(id);
    if (item?.type !== "tool_call") continue;
    if (item.call.detail.kind === "agent.spawn" && item.call.detail.childAgentId)
      children.push(item.call.detail.childAgentId);
  }
  for (const agentId of reader.agentIds()) {
    const by = reader.agent(agentId)?.spawnedBy;
    if (by && spawns.has(by) && !children.includes(agentId)) children.push(agentId);
  }
  return children;
}

/**
 * "Started 2 subagents ›", expanding inline into the agents it started, one row each (their
 * own subagents under them). The parent's own state is the turn's live line, not a row here.
 */
export function Subagents(props: { threadId: string; itemIds: readonly string[] }) {
  const keys = useMemo<ThreadKey[]>(
    () => ["agents", ...props.itemIds.map((id): ThreadKey => `item:${id}`)],
    [props.itemIds],
  );
  const read = useCallback(
    (reader: ThreadReader) => spawned(reader, props.itemIds),
    [props.itemIds],
  );
  const children = useThread(props.threadId, keys, read, arrayEqual) ?? [];
  const [open, setOpen] = useState(false);
  const workspace = useWorkspaceActions(props.threadId);
  const tree = useId();
  const count = Math.max(children.length, props.itemIds.length);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={tree}
        onClick={() => setOpen(!open)}
        className="-mx-1.5 inline-flex h-[26px] items-center gap-1.5 rounded-sm px-1.5 text-[13.5px] text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
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
        <div id={tree} className="fx-rise-in mt-1 mb-2 ml-2.5 border-l-2 pl-2.5">
          <div role="tree" aria-label="Subagents">
            {children.map((child) => (
              <AgentBranch key={child} threadId={props.threadId} agentId={child} depth={0} />
            ))}
          </div>
          <Menu>
            <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="Subagent actions" />} />
            <MenuContent>
              <MenuItem
                icon={<TreeStructureIcon aria-hidden />}
                shortcut="agents"
                onClick={() => workspace.open({ kind: "agents" })}
              >
                Open agent tree
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      )}
    </div>
  );
}
