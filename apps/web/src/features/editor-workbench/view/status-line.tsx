import { EditorStatusLine } from "@/features/editor";
import type { StatusNotice, StatusReport } from "./deck-host.ts";

/**
 * The Deck's one 24px status line, about the focused group's editor only (spec 41): on the
 * left what needs a look, on the right the editor's own status line (editor-commands'), drawn
 * once here instead of under every editor.
 */
export function StatusLine(props: {
  report: StatusReport | undefined;
  notice: StatusNotice | undefined;
}) {
  const { report } = props;
  // Spec 65: a read-only file says so here and nowhere else.
  const notice = props.notice ?? (report?.status.readOnly ? { text: "Read only" } : undefined);
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
