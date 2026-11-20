import { useCallback, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { AgentNotice } from "./agent-notice.tsx";
import { Breadcrumbs } from "./breadcrumbs.tsx";
import { useBufferFacts } from "./buffers.ts";
import type { DeckHost, EditorStatus } from "./deck-host.ts";
import { carriesTab, copiesOnDrop, readTabDrag } from "./drag.ts";
import { dropZone, type DropZone } from "./drop-zone.ts";
import { FileProblem, LoadingLines, NoFileOpen } from "./editor-states.tsx";
import type { GroupActions } from "./group-actions.ts";
import type { DeckGroup } from "./layout.ts";
import { TabStrip } from "./tab-strip.tsx";

/**
 * One group: its strip, breadcrumbs, the agent notice when the shown file's disk version moved
 * under unsaved edits, and the shown editor (only the active tab renders: spec 56). A tab dragged
 * over the editor washes the third it would take.
 */
export function GroupView(props: {
  group: DeckGroup;
  /** 1-based, in reading order: what ⌘1–9 calls it. */
  number: number;
  focused: boolean;
  /** The only group: its emptiness is the Deck's empty state. */
  last: boolean;
  host: DeckHost;
  actions: GroupActions;
  stripLead?: ReactNode;
  groupMenu?: ReactNode;
}) {
  const { group, host, actions } = props;
  const path = group.active;
  const facts = useBufferFacts(host.buffers, path);
  const [zone, setZone] = useState<DropZone | undefined>(undefined);
  const { reportStatus } = host;
  // Stable per group, so an editor can report from an effect without re-running it.
  const onStatus = useCallback(
    (status: EditorStatus | undefined) => reportStatus(group.id, status),
    [reportStatus, group.id],
  );
  return (
    <section
      aria-label={`Group ${props.number}`}
      data-group-id={group.id}
      data-focused={props.focused ? "" : undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      onFocusCapture={actions.focus}
      onPointerDownCapture={actions.focus}
    >
      <TabStrip
        group={group}
        focused={props.focused}
        buffers={host.buffers}
        actions={actions}
        lead={props.stripLead}
        groupMenu={props.groupMenu}
      />
      <Breadcrumbs path={path} />
      {path !== undefined && (
        <AgentNotice
          facts={facts}
          onMerge={() => host.onMerge(path)}
          onCompare={() => host.onCompare(path)}
        />
      )}
      <div
        data-part="deck-editor"
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => {
          if (!carriesTab(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = copiesOnDrop(event) ? "copy" : "move";
          const next = dropZone(
            { x: event.clientX, y: event.clientY },
            event.currentTarget.getBoundingClientRect(),
          );
          if (next !== zone) setZone(next);
        }}
        onDragLeave={(event) => {
          const into = event.relatedTarget;
          if (!(into instanceof Node && event.currentTarget.contains(into))) setZone(undefined);
        }}
        onDrop={(event) => {
          const drag = readTabDrag(event.dataTransfer);
          const at = zone ?? "center";
          setZone(undefined);
          if (!drag) return;
          event.preventDefault();
          actions.dropOnEditor(drag, at, copiesOnDrop(event));
        }}
      >
        {path === undefined ? (
          props.last ? (
            <NoFileOpen onQuickOpen={host.onQuickOpen} />
          ) : null
        ) : facts.load.state === "loading" ? (
          <LoadingLines />
        ) : facts.load.state === "ready" ? (
          host.renderEditor({
            path,
            group: group.id,
            focused: props.focused,
            onStatus,
          })
        ) : (
          <FileProblem
            path={path}
            load={facts.load}
            onClose={() => actions.close([path])}
            onRestore={host.onRestore && (() => host.onRestore?.(path))}
            onOpenReadOnly={host.onOpenReadOnly && (() => host.onOpenReadOnly?.(path))}
            onRetry={host.onRetry && (() => host.onRetry?.(path))}
          />
        )}
        {zone && <DropWash zone={zone} />}
      </div>
    </section>
  );
}

/** The `--active` wash over the part of the group a drop would take (spec 16). */
function DropWash(props: { zone: DropZone }) {
  return (
    <div
      aria-hidden
      data-drop-zone={props.zone}
      className={cn(
        "pointer-events-none absolute z-[2] rounded-sm bg-active/80 transition-[inset] duration-(--motion-fast)",
        props.zone === "center" && "inset-0",
        props.zone === "left" && "inset-y-0 right-1/2 left-0",
        props.zone === "right" && "inset-y-0 right-0 left-1/2",
        props.zone === "up" && "inset-x-0 top-0 bottom-1/2",
        props.zone === "down" && "inset-x-0 top-1/2 bottom-0",
      )}
    />
  );
}
