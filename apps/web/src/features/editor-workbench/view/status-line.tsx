import type { BufferFacts } from "./buffers.ts";
import type { EditorStatus, StatusNotice } from "./deck-host.ts";

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
 * left what needs a look (the editor's own notice first), on the right its facts as words.
 */
export function StatusLine(props: {
  status: EditorStatus | undefined;
  agentNotice: StatusNotice | undefined;
}) {
  const notice = props.status?.notice ?? props.agentNotice;
  return (
    <footer
      data-part="deck-status"
      aria-label="Editor status"
      className="flex h-6 shrink-0 items-center gap-3.5 border-t border-border px-3 text-xs whitespace-nowrap text-subtle-foreground"
    >
      {notice && (
        <span role="status" className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{notice.text}</span>
          {notice.action && <TextButton label={notice.action.label} run={notice.action.run} />}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1">
        {props.status?.items.map((item) =>
          item.run ? (
            <TextButton key={item.id} label={item.label} run={item.run} />
          ) : (
            <span key={item.id} className="px-1.5">
              {item.label}
            </span>
          ),
        )}
      </span>
    </footer>
  );
}

function TextButton(props: { label: string; run(): void }) {
  return (
    <button
      type="button"
      onClick={props.run}
      className="h-5 rounded-xs px-1.5 font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground"
    >
      {props.label}
    </button>
  );
}
