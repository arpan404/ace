import { EditorStatusLine } from "@/features/editor";
import type { BufferFacts } from "./buffers.ts";
import type { StatusNotice, StatusReport } from "./deck-host.ts";

/** Spec 45: who changed which open files that the person hasn't looked at yet. */
export function agentChangeNotice(
  facts: readonly BufferFacts[],
  onNextChange: (() => void) | undefined,
): StatusNotice | undefined {
  const unseen = facts.filter((each) => each.unseenAgentChange);
  if (unseen.length === 0) return undefined;
  const names = new Set(unseen.map((each) => each.changedBy?.name ?? ""));
  const [only] = names;
  const who = names.size === 1 && only ? only : "Agents";
  const files = unseen.length === 1 ? "1 open file" : `${unseen.length} open files`;
  return {
    text: `${who} changed ${files}`,
    action: onNextChange && { label: "Next change", run: onNextChange },
  };
}

/**
 * The Deck's one 24px status line, about the focused group's editor only (spec 41): on the
 * left what needs a look, on the right the editor's own status line (editor-commands'), drawn
 * once here instead of under every editor.
 */
export function StatusLine(props: {
  report: StatusReport | undefined;
  agentNotice: StatusNotice | undefined;
}) {
  const { report } = props;
  // Spec 65: a read-only file says so here and nowhere else.
  const notice = props.agentNotice ?? (report?.status.readOnly ? { text: "Read only" } : undefined);
  return (
    <div
      data-part="deck-status"
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border pl-3 text-xs whitespace-nowrap text-subtle-foreground"
    >
      {notice && (
        <span role="status" className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              onClick={notice.action.run}
              className="h-5 shrink-0 rounded-xs px-1.5 font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground"
            >
              {notice.action.label}
            </button>
          )}
        </span>
      )}
      {/* The editor's line brings its own top edge and fill; inside this one they would double. */}
      <div className="ml-auto flex min-w-0 [&>footer]:h-auto [&>footer]:border-t-0 [&>footer]:bg-transparent">
        {report && <EditorStatusLine status={report.status} actions={report.actions} />}
      </div>
    </div>
  );
}
