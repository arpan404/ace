import { Button } from "@/components/ui/button.tsx";
import { usePanelServices } from "../services.ts";
import { finishComposition, updateComposition, type ReviewComposition } from "./compositions.ts";
import { saveDraft } from "./drafts.ts";
import { CommentComposer, linesLabel } from "./line-comment.tsx";

/** The mounted editor is controlled by the retained composition, including stale evidence. */
export function CompositionEditor(props: {
  composition: ReviewComposition;
  blocked?: string | undefined;
  onReselect(): void;
}) {
  const services = usePanelServices();
  const entry = props.composition;
  const range = entry.range;
  return (
    <>
      <CommentComposer
        label={`Comment on ${linesLabel(range.side, range.start, range.end)}`}
        text={entry.text}
        suggestion={entry.suggestion}
        onText={(text) => updateComposition(services.compositions, entry.id, { text })}
        onSuggestion={(suggestion) =>
          updateComposition(services.compositions, entry.id, { suggestion })
        }
        blocked={props.blocked}
        suggestFrom={range.side === "new" ? entry.fingerprint?.lines.join("\n") : undefined}
        onCancel={() => finishComposition(services.compositions, entry.id)}
        onSave={(text, suggestion) => {
          if (props.blocked) return;
          const draft = services.drafts.get().find((each) => each.key === entry.key);
          if (entry.key !== undefined && !draft) {
            finishComposition(services.compositions, entry.id);
            return;
          }
          if (!services.compositions.get().entries.has(entry.id)) return;
          saveDraft(services.drafts, {
            key: draft && !draft.commentId ? draft.key : entry.id,
            threadId: entry.threadId,
            file: entry.file,
            side: range.side,
            line: range.start,
            ...(range.end > range.start ? { end: range.end } : {}),
            fingerprint: entry.fingerprint,
            source: entry.source,
            text,
            ...(suggestion === undefined ? {} : { suggestion }),
            createdAt: Date.now(),
          });
          finishComposition(services.compositions, entry.id);
        }}
      />
      {props.blocked && (
        <Button size="sm" variant="ghost" className="mx-2.5 mb-2" onClick={props.onReselect}>
          Reselect lines
        </Button>
      )}
    </>
  );
}
